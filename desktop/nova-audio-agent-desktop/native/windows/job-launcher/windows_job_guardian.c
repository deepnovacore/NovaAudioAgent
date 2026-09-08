#define _WIN32_WINNT 0x0A00

// clang-format off: project convention keeps windows.h first for SDK types.
#include <windows.h>
// clang-format on
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define NOVA_CONTROL_FRAME_LIMIT 4096
#define NOVA_PATH_CAPACITY 32768
#define NOVA_MAX_ARGUMENTS 64
#define NOVA_CONTROL_FD 3
#define NOVA_TARGET_STDIN_FD 0
#define NOVA_TARGET_STDOUT_FD 1
#define NOVA_TARGET_STDERR_FD 2
#define NOVA_TREE_EXIT_TIMEOUT_MS 5000UL
#define NOVA_CONTROL_IO_TIMEOUT_MS 5000UL

static const char NOVA_FORCE_FRAME[] = "{\"type\":\"force\",\"version\":1}\n";

typedef struct {
  HANDLE source;
  HANDLE stop_event;
} nova_watch;

static int nova_overlapped_write(HANDLE output, const void *buffer,
                                 DWORD length, DWORD *written) {
  OVERLAPPED operation;
  ZeroMemory(&operation, sizeof(operation));
  operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (operation.hEvent == NULL)
    return 0;
  *written = 0;
  int success = WriteFile(output, buffer, length, written, &operation) != FALSE;
  if (!success && GetLastError() == ERROR_IO_PENDING) {
    DWORD wait =
        WaitForSingleObject(operation.hEvent, NOVA_CONTROL_IO_TIMEOUT_MS);
    if (wait == WAIT_OBJECT_0) {
      success =
          GetOverlappedResult(output, &operation, written, FALSE) != FALSE;
    } else {
      (void)CancelIoEx(output, &operation);
      /* Cancellation is asynchronous: drain terminal completion before the
         stack-owned OVERLAPPED, buffer, and event leave scope. */
      (void)GetOverlappedResult(output, &operation, written, TRUE);
      success = 0;
    }
  }
  CloseHandle(operation.hEvent);
  return success;
}

static int nova_overlapped_read(HANDLE source, void *buffer, DWORD length,
                                DWORD *read) {
  OVERLAPPED operation;
  ZeroMemory(&operation, sizeof(operation));
  operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (operation.hEvent == NULL)
    return 0;
  *read = 0;
  int success = ReadFile(source, buffer, length, read, &operation) != FALSE;
  if (!success && GetLastError() == ERROR_IO_PENDING) {
    if (WaitForSingleObject(operation.hEvent, INFINITE) == WAIT_OBJECT_0) {
      success = GetOverlappedResult(source, &operation, read, FALSE) != FALSE;
    }
  }
  CloseHandle(operation.hEvent);
  return success;
}

static void nova_fail(void) {
  static const char message[] = "windows_job_guardian_failed\n";
  HANDLE error = GetStdHandle(STD_ERROR_HANDLE);
  DWORD written = 0;
  if (error != NULL && error != INVALID_HANDLE_VALUE) {
    (void)nova_overlapped_write(error, message, (DWORD)(sizeof(message) - 1),
                                &written);
  }
}

static int nova_utf8_command_is_bounded(void) {
  int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                                  GetCommandLineW(), -1, NULL, 0, NULL, NULL);
  return bytes > 1 && bytes - 1 <= NOVA_CONTROL_FRAME_LIMIT;
}

static int nova_control_character(WCHAR value) {
  return value < 0x20 || value == 0x7f;
}

static int nova_argument_is_safe(const WCHAR *value) {
  if (value == NULL || *value == L'\0')
    return 0;
  for (const WCHAR *cursor = value; *cursor != L'\0'; cursor += 1) {
    if (nova_control_character(*cursor))
      return 0;
    if (*cursor >= 0xD800 && *cursor <= 0xDBFF) {
      cursor += 1;
      if (*cursor < 0xDC00 || *cursor > 0xDFFF)
        return 0;
    } else if (*cursor >= 0xDC00 && *cursor <= 0xDFFF)
      return 0;
  }
  return 1;
}

static int nova_quote_argument(const WCHAR *value, WCHAR *output,
                               size_t capacity, size_t *used) {
  if (!nova_argument_is_safe(value) || *used + 2 >= capacity)
    return 0;
  output[(*used)++] = L'"';
  size_t slashes = 0;
  for (const WCHAR *cursor = value;; cursor += 1) {
    WCHAR current = *cursor;
    if (current == L'\\') {
      slashes += 1;
      continue;
    }
    if (current == L'"' || current == L'\0') {
      size_t copies = slashes * 2 + (current == L'"' ? 1 : 0);
      if (*used + copies + 2 >= capacity)
        return 0;
      while (copies-- > 0)
        output[(*used)++] = L'\\';
      slashes = 0;
      if (current == L'\0')
        break;
      output[(*used)++] = L'"';
      continue;
    }
    if (*used + slashes + 2 >= capacity)
      return 0;
    while (slashes-- > 0)
      output[(*used)++] = L'\\';
    slashes = 0;
    output[(*used)++] = current;
  }
  output[(*used)++] = L'"';
  output[*used] = L'\0';
  return 1;
}

static int nova_build_command_line(int argument_count, WCHAR **arguments,
                                   WCHAR output[NOVA_PATH_CAPACITY]) {
  if (argument_count < 1 || argument_count > NOVA_MAX_ARGUMENTS)
    return 0;
  size_t used = 0;
  for (int index = 0; index < argument_count; index += 1) {
    if (index > 0) {
      if (used + 2 >= NOVA_PATH_CAPACITY)
        return 0;
      output[used++] = L' ';
      output[used] = L'\0';
    }
    if (!nova_quote_argument(arguments[index], output, NOVA_PATH_CAPACITY,
                             &used))
      return 0;
  }
  return 1;
}

static int nova_canonical_existing(const WCHAR *path, int directory,
                                   WCHAR output[NOVA_PATH_CAPACITY]) {
  DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT;
  if (directory)
    flags |= FILE_FLAG_BACKUP_SEMANTICS;
  HANDLE handle =
      CreateFileW(path, FILE_READ_ATTRIBUTES,
                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                  OPEN_EXISTING, flags, NULL);
  if (handle == INVALID_HANDLE_VALUE)
    return 0;
  FILE_ATTRIBUTE_TAG_INFO tag;
  BY_HANDLE_FILE_INFORMATION info;
  int valid =
      GetFileInformationByHandle(handle, &info) &&
      GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag,
                                   (DWORD)sizeof(tag)) &&
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
      (((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory);
  if (valid) {
    DWORD length =
        GetFinalPathNameByHandleW(handle, output, NOVA_PATH_CAPACITY,
                                  FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    valid = length > 0 && length < NOVA_PATH_CAPACITY;
    if (valid && wcsncmp(output, L"\\\\?\\", 4) == 0) {
      memmove(output, output + 4, (wcslen(output + 4) + 1) * sizeof(WCHAR));
    }
  }
  CloseHandle(handle);
  return valid && _wcsicmp(output, path) == 0;
}

static int nova_native_target(const WCHAR *path,
                              WCHAR output[NOVA_PATH_CAPACITY]) {
  size_t length = wcslen(path);
  DWORD binary_type = 0;
  if (length < 5 || _wcsicmp(path + length - 4, L".exe") != 0 ||
      !nova_canonical_existing(path, 0, output) ||
      !GetBinaryTypeW(output, &binary_type) || binary_type != SCS_64BIT_BINARY)
    return 0;
  return 1;
}

static HANDLE nova_descriptor_handle(int descriptor) {
  intptr_t raw = _get_osfhandle(descriptor);
  if (raw == -1)
    return INVALID_HANDLE_VALUE;
  HANDLE handle = (HANDLE)raw;
  return handle == NULL ? INVALID_HANDLE_VALUE : handle;
}

static int nova_pipe_handle(HANDLE handle) {
  return handle != INVALID_HANDLE_VALUE &&
         GetFileType(handle) == FILE_TYPE_PIPE;
}

static int nova_duplicate_inheritable(HANDLE source, HANDLE *output) {
  return DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(),
                         output, 0, TRUE, DUPLICATE_SAME_ACCESS) != FALSE;
}

static DWORD WINAPI nova_watch_pipe(LPVOID raw) {
  nova_watch *watch = (nova_watch *)raw;
  char frame[NOVA_CONTROL_FRAME_LIMIT + 1];
  DWORD used = 0;
  while (used <= NOVA_CONTROL_FRAME_LIMIT) {
    DWORD bytes = 0;
    if (!nova_overlapped_read(watch->source, frame + used, 1, &bytes) ||
        bytes == 0)
      break;
    used += 1;
    if (frame[used - 1] == '\n') {
      if (used == sizeof(NOVA_FORCE_FRAME) - 1 &&
          memcmp(frame, NOVA_FORCE_FRAME, sizeof(NOVA_FORCE_FRAME) - 1) == 0) {
        SetEvent(watch->stop_event);
        return 0;
      }
      break;
    }
  }
  SetEvent(watch->stop_event);
  return 0;
}

static int nova_write_frame(HANDLE output, const char *frame, size_t length) {
  size_t offset = 0;
  if (length == 0 || length > NOVA_CONTROL_FRAME_LIMIT)
    return 0;
  while (offset < length) {
    DWORD written = 0;
    if (!nova_overlapped_write(output, frame + offset, (DWORD)(length - offset),
                               &written) ||
        written == 0) {
      return 0;
    }
    offset += written;
  }
  return 1;
}

static int nova_ready_frame(HANDLE output, DWORD process_id) {
  char frame[128];
  int length =
      sprintf_s(frame, sizeof(frame),
                "{\"type\":\"ready\",\"version\":1,\"targetPid\":%lu}\n",
                (unsigned long)process_id);
  return length > 0 && nova_write_frame(output, frame, (size_t)length);
}

static int nova_exit_frame(HANDLE output, int have_code, DWORD process_code) {
  char frame[160];
  int length;
  if (have_code) {
    length = sprintf_s(frame, sizeof(frame),
                       "{\"type\":\"exit\",\"version\":1,\"leaderExitCode\":%"
                       "ld,\"treeEmpty\":true}\n",
                       (long)(int32_t)process_code);
  } else {
    length = sprintf_s(frame, sizeof(frame),
                       "{\"type\":\"exit\",\"version\":1,\"leaderExitCode\":"
                       "null,\"treeEmpty\":true}\n");
  }
  return length > 0 && nova_write_frame(output, frame, (size_t)length);
}

static int nova_wait_for_tree(HANDLE job, HANDLE completion, HANDLE leader,
                              HANDLE stop_event, DWORD *leader_code,
                              int *have_code) {
  int force_sent = 0;
  ULONGLONG deadline = 0;
  for (;;) {
    if (!force_sent && WaitForSingleObject(stop_event, 0) == WAIT_OBJECT_0) {
      force_sent = 1;
      deadline = GetTickCount64() + NOVA_TREE_EXIT_TIMEOUT_MS;
      (void)TerminateJobObject(job, 1);
    }
    if (!*have_code && WaitForSingleObject(leader, 0) == WAIT_OBJECT_0) {
      *have_code = GetExitCodeProcess(leader, leader_code) != FALSE;
    }
    DWORD message = 0;
    ULONG_PTR key = 0;
    LPOVERLAPPED overlapped = NULL;
    if (GetQueuedCompletionStatus(completion, &message, &key, &overlapped,
                                  25)) {
      (void)key;
      (void)overlapped;
      if (message == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO)
        return 1;
    }
    if (force_sent && GetTickCount64() >= deadline)
      return 0;
  }
}

static void nova_stop_watcher(HANDLE thread, HANDLE source) {
  if (thread == NULL)
    return;
  (void)CancelSynchronousIo(thread);
  if (source != INVALID_HANDLE_VALUE)
    (void)CancelIoEx(source, NULL);
  (void)WaitForSingleObject(thread, 1000);
  CloseHandle(thread);
}

static int nova_guardian(int argc, WCHAR **argv) {
  if (!nova_utf8_command_is_bounded() || argc < 7 ||
      wcscmp(argv[1], L"--target") != 0 || wcscmp(argv[3], L"--cwd") != 0 ||
      wcscmp(argv[5], L"--") != 0)
    return 0;
  WCHAR target[NOVA_PATH_CAPACITY];
  WCHAR cwd[NOVA_PATH_CAPACITY];
  if (!nova_native_target(argv[2], target) ||
      !nova_canonical_existing(argv[4], 1, cwd))
    return 0;
  WCHAR command[NOVA_PATH_CAPACITY];
  if (!nova_build_command_line(argc - 6, argv + 6, command) ||
      _wcsicmp(argv[6], target) != 0)
    return 0;

  HANDLE control = nova_descriptor_handle(NOVA_CONTROL_FD);
  HANDLE target_input_source = nova_descriptor_handle(NOVA_TARGET_STDIN_FD);
  HANDLE target_output_source = nova_descriptor_handle(NOVA_TARGET_STDOUT_FD);
  HANDLE target_error_source = nova_descriptor_handle(NOVA_TARGET_STDERR_FD);
  if (!nova_pipe_handle(control) || !nova_pipe_handle(target_input_source) ||
      !nova_pipe_handle(target_output_source) ||
      !nova_pipe_handle(target_error_source))
    return 0;
  (void)SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0);

  HANDLE stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (stop_event == NULL)
    return 0;
  nova_watch control_watch = {control, stop_event};
  HANDLE control_thread =
      CreateThread(NULL, 0, nova_watch_pipe, &control_watch, 0, NULL);
  if (control_thread == NULL) {
    SetEvent(stop_event);
    CloseHandle(stop_event);
    return 0;
  }

  HANDLE target_input = INVALID_HANDLE_VALUE;
  HANDLE target_output = INVALID_HANDLE_VALUE;
  HANDLE target_error = INVALID_HANDLE_VALUE;
  HANDLE job = NULL;
  HANDLE completion = NULL;
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
  int attributes_initialized = 0;
  PROCESS_INFORMATION process;
  ZeroMemory(&process, sizeof(process));
  int success = 0;
  if (!nova_duplicate_inheritable(target_input_source, &target_input) ||
      !nova_duplicate_inheritable(target_output_source, &target_output) ||
      !nova_duplicate_inheritable(target_error_source, &target_error))
    goto cleanup;
  if (_close(NOVA_TARGET_STDIN_FD) != 0 || _close(NOVA_TARGET_STDOUT_FD) != 0 ||
      _close(NOVA_TARGET_STDERR_FD) != 0)
    goto cleanup;
  job = CreateJobObjectW(NULL, NULL);
  completion = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  if (job == NULL || completion == NULL)
    goto cleanup;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               (DWORD)sizeof(limits)))
    goto cleanup;
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT port = {job, completion};
  if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation,
                               &port, (DWORD)sizeof(port))) {
    goto cleanup;
  }
  SIZE_T attribute_bytes = 0;
  (void)InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_bytes);
  attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(
      GetProcessHeap(), HEAP_ZERO_MEMORY, attribute_bytes);
  if (attributes == NULL ||
      !InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_bytes))
    goto cleanup;
  attributes_initialized = 1;
  HANDLE inherited[] = {target_input, target_output, target_error};
  if (!UpdateProcThreadAttribute(attributes, 0,
                                 PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                 sizeof(inherited), NULL, NULL))
    goto cleanup;
  STARTUPINFOEXW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.StartupInfo.cb = (DWORD)sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = target_input;
  startup.StartupInfo.hStdOutput = target_output;
  startup.StartupInfo.hStdError = target_error;
  startup.lpAttributeList = attributes;
  if (!CreateProcessW(target, command, NULL, NULL, TRUE,
                      CREATE_SUSPENDED | CREATE_NO_WINDOW |
                          CREATE_UNICODE_ENVIRONMENT |
                          EXTENDED_STARTUPINFO_PRESENT,
                      NULL, cwd, &startup.StartupInfo, &process))
    goto cleanup;
  if (!AssignProcessToJobObject(job, process.hProcess))
    goto cleanup;
  if (WaitForSingleObject(stop_event, 0) == WAIT_OBJECT_0)
    goto cleanup;
  if (ResumeThread(process.hThread) == (DWORD)-1)
    goto cleanup;
  CloseHandle(process.hThread);
  process.hThread = NULL;
  CloseHandle(target_input);
  target_input = INVALID_HANDLE_VALUE;
  CloseHandle(target_output);
  target_output = INVALID_HANDLE_VALUE;
  CloseHandle(target_error);
  target_error = INVALID_HANDLE_VALUE;
  if (!nova_ready_frame(control, process.dwProcessId))
    goto cleanup;
  DWORD leader_code = 0;
  int have_code = 0;
  if (!nova_wait_for_tree(job, completion, process.hProcess, stop_event,
                          &leader_code, &have_code))
    goto cleanup;
  if (!have_code &&
      WaitForSingleObject(process.hProcess, 1000) == WAIT_OBJECT_0) {
    have_code = GetExitCodeProcess(process.hProcess, &leader_code) != FALSE;
  }
  if (!nova_exit_frame(control, have_code, leader_code))
    goto cleanup;
  success = 1;

cleanup:
  if (!success && job != NULL)
    (void)TerminateJobObject(job, 1);
  if (process.hThread != NULL) {
    (void)TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
  }
  if (process.hProcess != NULL) {
    (void)WaitForSingleObject(process.hProcess, NOVA_TREE_EXIT_TIMEOUT_MS);
    CloseHandle(process.hProcess);
  }
  if (attributes != NULL) {
    if (attributes_initialized)
      DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
  }
  if (target_input != INVALID_HANDLE_VALUE)
    CloseHandle(target_input);
  if (target_output != INVALID_HANDLE_VALUE)
    CloseHandle(target_output);
  if (target_error != INVALID_HANDLE_VALUE)
    CloseHandle(target_error);
  if (completion != NULL)
    CloseHandle(completion);
  if (job != NULL)
    CloseHandle(job);
  nova_stop_watcher(control_thread, control);
  CloseHandle(stop_event);
  return success;
}

int wmain(int argc, WCHAR **argv) {
  if (!nova_guardian(argc, argv)) {
    nova_fail();
    return 2;
  }
  return 0;
}
