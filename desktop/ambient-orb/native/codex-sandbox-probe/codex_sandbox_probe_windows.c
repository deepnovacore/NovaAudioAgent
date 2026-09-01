#define _WIN32_WINNT 0x0A00

// clang-format off: winsock2.h must precede windows.h.
#include <winsock2.h>
#include <windows.h>
// clang-format on
#include <direct.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <ws2tcpip.h>

#define NOVA_PATH_CAPACITY 32768
#define NOVA_CHILD_TIMEOUT_MS 2000UL
#define NOVA_NETWORK_TIMEOUT_MS 1000L

static const WCHAR *NOVA_SIBLING_PREFIX = L".nova-audio-agent-codex-preflight-";
static const WCHAR *NOVA_MARKER_PREFIX = L".nova-audio-agent-codex-preflight-";

static int nova_starts_with(const WCHAR *value, const WCHAR *prefix) {
  return wcsncmp(value, prefix, wcslen(prefix)) == 0;
}

static const WCHAR *nova_basename(const WCHAR *path) {
  const WCHAR *slash = wcsrchr(path, L'\\');
  const WCHAR *alternate = wcsrchr(path, L'/');
  if (alternate != NULL && (slash == NULL || alternate > slash))
    slash = alternate;
  return slash == NULL ? path : slash + 1;
}

static int nova_parent(const WCHAR *path, WCHAR output[NOVA_PATH_CAPACITY]) {
  size_t length = wcslen(path);
  if (length == 0 || length >= NOVA_PATH_CAPACITY)
    return 0;
  wcscpy_s(output, NOVA_PATH_CAPACITY, path);
  WCHAR *slash = wcsrchr(output, L'\\');
  WCHAR *alternate = wcsrchr(output, L'/');
  if (alternate != NULL && (slash == NULL || alternate > slash))
    slash = alternate;
  if (slash == NULL || slash <= output + 2)
    return 0;
  *slash = L'\0';
  return 1;
}

static int nova_canonical_existing(const WCHAR *path, int directory,
                                   WCHAR output[NOVA_PATH_CAPACITY]) {
  DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT;
  if (directory)
    flags |= FILE_FLAG_BACKUP_SEMANTICS;
  HANDLE handle =
      CreateFileW(path, FILE_READ_ATTRIBUTES | READ_CONTROL,
                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                  OPEN_EXISTING, flags, NULL);
  if (handle == INVALID_HANDLE_VALUE)
    return 0;
  FILE_ATTRIBUTE_TAG_INFO tag;
  BY_HANDLE_FILE_INFORMATION info;
  int valid = GetFileInformationByHandle(handle, &info) &&
              GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag,
                                           (DWORD)sizeof(tag)) &&
              (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
               (((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) ==
                directory);
  DWORD length = 0;
  if (valid) {
    length = GetFinalPathNameByHandleW(handle, output, NOVA_PATH_CAPACITY,
                                       FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    valid = length > 0 && length < NOVA_PATH_CAPACITY;
    if (valid && wcsncmp(output, L"\\\\?\\", 4) == 0) {
      memmove(output, output + 4, (wcslen(output + 4) + 1) * sizeof(WCHAR));
    }
  }
  CloseHandle(handle);
  return valid;
}

static int nova_regular(const WCHAR *path) {
  WCHAR canonical[NOVA_PATH_CAPACITY];
  return nova_canonical_existing(path, 0, canonical) &&
         _wcsicmp(canonical, path) == 0;
}

static int nova_validate_canary(const WCHAR *path, const WCHAR *workspace) {
  if (_wcsicmp(nova_basename(path), L"canary") != 0 ||
      !nova_regular(path))
    return 0;
  WCHAR sibling[NOVA_PATH_CAPACITY];
  WCHAR common_parent[NOVA_PATH_CAPACITY];
  WCHAR workspace_parent[NOVA_PATH_CAPACITY];
  if (!nova_parent(path, sibling) ||
      !nova_starts_with(nova_basename(sibling), NOVA_SIBLING_PREFIX) ||
      !nova_parent(sibling, common_parent) ||
      !nova_parent(workspace, workspace_parent))
    return 0;
  return _wcsicmp(common_parent, workspace_parent) == 0;
}

static int nova_validate_child_canary(const WCHAR *path) {
  if (_wcsicmp(nova_basename(path), L"canary") != 0 ||
      !nova_regular(path))
    return 0;
  WCHAR sibling[NOVA_PATH_CAPACITY];
  return nova_parent(path, sibling) &&
         nova_starts_with(nova_basename(sibling), NOVA_SIBLING_PREFIX);
}

static int nova_validate_marker(const WCHAR *marker, const WCHAR *workspace) {
  WCHAR parent[NOVA_PATH_CAPACITY];
  if (!nova_parent(marker, parent) || _wcsicmp(parent, workspace) != 0)
    return 0;
  const WCHAR *name = nova_basename(marker);
  size_t prefix = wcslen(NOVA_MARKER_PREFIX);
  if (!nova_starts_with(name, NOVA_MARKER_PREFIX) ||
      wcslen(name) != prefix + 32)
    return 0;
  for (size_t index = prefix; index < prefix + 32; index += 1) {
    WCHAR value = name[index];
    if (!((value >= L'0' && value <= L'9') || (value >= L'a' && value <= L'f')))
      return 0;
  }
  DWORD attributes = GetFileAttributesW(marker);
  return attributes == INVALID_FILE_ATTRIBUTES &&
         GetLastError() == ERROR_FILE_NOT_FOUND;
}

static int nova_write_exact(HANDLE handle, const char *value) {
  DWORD length = (DWORD)strlen(value);
  DWORD offset = 0;
  while (offset < length) {
    DWORD written = 0;
    if (!WriteFile(handle, value + offset, length - offset, &written, NULL) ||
        written == 0)
      return 0;
    offset += written;
  }
  return 1;
}

static int nova_attempt_write(const WCHAR *path, const char *value,
                              int exclusive) {
  HANDLE handle =
      CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE,
                  NULL, exclusive ? CREATE_NEW : TRUNCATE_EXISTING,
                  FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE)
    return 0;
  FILE_ATTRIBUTE_TAG_INFO tag;
  int succeeded = GetFileInformationByHandleEx(handle, FileAttributeTagInfo,
                                               &tag, (DWORD)sizeof(tag)) &&
                  (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY |
                                         FILE_ATTRIBUTE_REPARSE_POINT)) == 0 &&
                  nova_write_exact(handle, value) && FlushFileBuffers(handle);
  if (!CloseHandle(handle))
    succeeded = 0;
  return succeeded;
}

static int nova_self_path(WCHAR output[NOVA_PATH_CAPACITY]) {
  DWORD length = GetModuleFileNameW(NULL, output, NOVA_PATH_CAPACITY);
  return length > 0 && length < NOVA_PATH_CAPACITY;
}

static int nova_quote_argument(const WCHAR *value, WCHAR *output,
                               size_t capacity, size_t *used) {
  if (*used + 2 >= capacity)
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

static int nova_child_denied(const WCHAR *canary) {
  WCHAR executable[NOVA_PATH_CAPACITY];
  WCHAR command[NOVA_PATH_CAPACITY];
  size_t used = 0;
  if (!nova_self_path(executable) ||
      !nova_quote_argument(executable, command, NOVA_PATH_CAPACITY, &used)) {
    return 0;
  }
  const WCHAR *child_flag = L" --child ";
  size_t flag_length = wcslen(child_flag);
  if (used + flag_length + 1 >= NOVA_PATH_CAPACITY)
    return 0;
  memcpy(command + used, child_flag, flag_length * sizeof(WCHAR));
  used += flag_length;
  command[used] = L'\0';
  if (!nova_quote_argument(canary, command, NOVA_PATH_CAPACITY, &used))
    return 0;
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = (DWORD)sizeof(startup);
  if (!CreateProcessW(executable, command, NULL, NULL, FALSE,
                      CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, NULL, NULL,
                      &startup, &process))
    return 0;
  CloseHandle(process.hThread);
  DWORD waited = WaitForSingleObject(process.hProcess, NOVA_CHILD_TIMEOUT_MS);
  if (waited == WAIT_TIMEOUT) {
    (void)TerminateProcess(process.hProcess, 127);
    (void)WaitForSingleObject(process.hProcess, NOVA_CHILD_TIMEOUT_MS);
  }
  DWORD code = 127;
  int denied = waited == WAIT_OBJECT_0 &&
               GetExitCodeProcess(process.hProcess, &code) && code == 0;
  CloseHandle(process.hProcess);
  return denied;
}

static int nova_network_denied(uint16_t port) {
  WSADATA data;
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0)
    return 1;
  SOCKET descriptor = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (descriptor == INVALID_SOCKET) {
    WSACleanup();
    return 1;
  }
  u_long nonblocking = 1;
  if (ioctlsocket(descriptor, FIONBIO, &nonblocking) != 0) {
    closesocket(descriptor);
    WSACleanup();
    return 1;
  }
  struct sockaddr_in address;
  ZeroMemory(&address, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int connected = connect(descriptor, (const struct sockaddr *)&address,
                          (int)sizeof(address)) == 0;
  if (!connected && WSAGetLastError() == WSAEWOULDBLOCK) {
    fd_set writes;
    FD_ZERO(&writes);
    FD_SET(descriptor, &writes);
    struct timeval timeout = {NOVA_NETWORK_TIMEOUT_MS / 1000L, 0};
    if (select(0, NULL, &writes, NULL, &timeout) > 0) {
      int socket_error = 1;
      int length = (int)sizeof(socket_error);
      connected = getsockopt(descriptor, SOL_SOCKET, SO_ERROR,
                             (char *)&socket_error, &length) == 0 &&
                  socket_error == 0;
    }
  }
  closesocket(descriptor);
  WSACleanup();
  return !connected;
}

static const char *nova_limit_class(DWORD flags, DWORD process_flag,
                                    DWORD job_flag) {
  return (flags & (process_flag | job_flag)) != 0 ? "finite" : "unbounded";
}

static void nova_limits(const char **cpu, const char **memory,
                        const char **nofile) {
  BOOL in_job = FALSE;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  if (!IsProcessInJob(GetCurrentProcess(), NULL, &in_job) || !in_job ||
      !QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation,
                                 &limits, (DWORD)sizeof(limits), NULL)) {
    *cpu = "unbounded";
    *memory = "unbounded";
    *nofile = "unavailable";
    return;
  }
  DWORD flags = limits.BasicLimitInformation.LimitFlags;
  *cpu = nova_limit_class(flags, JOB_OBJECT_LIMIT_PROCESS_TIME,
                          JOB_OBJECT_LIMIT_JOB_TIME);
  *memory = nova_limit_class(flags, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
                             JOB_OBJECT_LIMIT_JOB_MEMORY);
  *nofile = "unavailable";
}

static int nova_child_main(const WCHAR *canary) {
  if (!nova_validate_child_canary(canary))
    return 2;
  return nova_attempt_write(canary, "child-write-succeeded", 0) ? 9 : 0;
}

static int nova_main(int argc, WCHAR **argv) {
  if (argc == 3 && wcscmp(argv[1], L"--child") == 0)
    return nova_child_main(argv[2]);
  if (argc != 6 || wcscmp(argv[1], L"--main") != 0)
    return 2;
  WCHAR workspace[NOVA_PATH_CAPACITY];
  WCHAR canary[NOVA_PATH_CAPACITY];
  if (!nova_canonical_existing(argv[2], 1, workspace) ||
      _wcsicmp(workspace, argv[2]) != 0 ||
      !nova_canonical_existing(argv[3], 0, canary) ||
      _wcsicmp(canary, argv[3]) != 0 ||
      !nova_validate_canary(canary, workspace) ||
      !nova_validate_marker(argv[4], workspace))
    return 2;
  WCHAR *end = NULL;
  unsigned long port_number = wcstoul(argv[5], &end, 10);
  if (end == argv[5] || *end != L'\0' || port_number < 1 || port_number > 65535)
    return 2;

  WCHAR current[NOVA_PATH_CAPACITY];
  WCHAR current_canonical[NOVA_PATH_CAPACITY];
  int cwd_matches = _wgetcwd(current, NOVA_PATH_CAPACITY) != NULL &&
                    nova_canonical_existing(current, 1, current_canonical) &&
                    _wcsicmp(current_canonical, workspace) == 0;
  int inside_write =
      nova_attempt_write(argv[4], "nova-audio-agent-preflight", 1);
  int inside_remove = DeleteFileW(argv[4]) != FALSE;
  int outside_write_denied =
      !nova_attempt_write(canary, "outside-write-succeeded", 0);
  int child_outside_write_denied = nova_child_denied(canary);
  int network_denied = nova_network_denied((uint16_t)port_number);
  const char *cpu;
  const char *memory;
  const char *nofile;
  nova_limits(&cpu, &memory, &nofile);
  int written = printf(
      "{\"cwd_matches\":%s,\"inside_write\":%s,\"inside_remove\":%s,"
      "\"outside_write_denied\":%s,\"child_outside_write_denied\":%s,"
      "\"network_denied\":%s,\"limits\":{\"cpu\":\"%s\",\"as\":\"%s\","
      "\"nofile\":\"%s\"}}\n",
      cwd_matches ? "true" : "false", inside_write ? "true" : "false",
      inside_remove ? "true" : "false", outside_write_denied ? "true" : "false",
      child_outside_write_denied ? "true" : "false",
      network_denied ? "true" : "false", cpu, memory, nofile);
  return written > 0 && fflush(stdout) == 0 ? 0 : 2;
}

int wmain(int argc, WCHAR **argv) { return nova_main(argc, argv); }
