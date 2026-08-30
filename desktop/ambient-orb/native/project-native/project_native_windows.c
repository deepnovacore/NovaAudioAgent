#define _WIN32_WINNT 0x0A00

// clang-format off: Windows SDK headers require windows.h before aclapi.h.
#include <windows.h>
#include <aclapi.h>
#include <delayimp.h>
// clang-format on
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <uchar.h>
#include <wchar.h>
#include <winternl.h>

#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000UL
#endif

#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001UL
#endif

#ifndef FILE_CREATE
#define FILE_CREATE 0x00000002UL
#endif

#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001UL
#endif

#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020UL
#endif

#ifndef FILE_NON_DIRECTORY_FILE
#define FILE_NON_DIRECTORY_FILE 0x00000040UL
#endif

#ifndef FILE_OPEN_FOR_BACKUP_INTENT
#define FILE_OPEN_FOR_BACKUP_INTENT 0x00004000UL
#endif

#ifndef FILE_DISPOSITION_FLAG_DELETE
#define FILE_DISPOSITION_FLAG_DELETE 0x00000001UL
#define FILE_DISPOSITION_FLAG_POSIX_SEMANTICS 0x00000002UL
#define FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE 0x00000010UL
#endif

#define NOVA_STATUS_OBJECT_NAME_NOT_FOUND ((NTSTATUS)0xC0000034L)
#define NOVA_STATUS_OBJECT_NAME_COLLISION ((NTSTATUS)0xC0000035L)
#define NOVA_STATUS_OBJECT_PATH_NOT_FOUND ((NTSTATUS)0xC000003AL)
#define NOVA_STATUS_SUCCESS ((NTSTATUS)0x00000000L)
#define NOVA_FILE_RENAME_INFORMATION ((FILE_INFORMATION_CLASS)10)
#define NOVA_DIRECTORY_ENUM_BUFFER_BYTES (64U * 1024U)
#define NOVA_REMOVE_TREE_MAX_DEPTH 64U

typedef NTSTATUS(NTAPI *nova_nt_create_file_fn)(PHANDLE, ACCESS_MASK,
                                                POBJECT_ATTRIBUTES,
                                                PIO_STATUS_BLOCK,
                                                PLARGE_INTEGER, ULONG, ULONG,
                                                ULONG, ULONG, PVOID, ULONG);
typedef intptr_t(__cdecl *nova_uv_get_osfhandle_fn)(int);
typedef NTSTATUS(NTAPI *nova_nt_set_information_file_fn)(
    HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
typedef NTSTATUS(NTAPI *nova_nt_flush_buffers_file_ex_fn)(
    HANDLE, ULONG, PVOID, ULONG, PIO_STATUS_BLOCK);

typedef struct {
  HANDLE handle;
  OVERLAPPED range;
} nova_lock_handle;

typedef struct nova_directory_handle_tag {
  int descriptor;
  HANDLE handle;
  int registered;
  struct nova_directory_handle_tag *next;
} nova_directory_handle;

typedef struct {
  DWORD Flags;
} nova_file_disposition_info_ex;

typedef struct {
  BYTE *token_user;
  PACL acl;
  SECURITY_DESCRIPTOR descriptor;
} nova_private_security;

static SRWLOCK nova_directory_lock = SRWLOCK_INIT;
static nova_directory_handle *nova_directories = NULL;
static volatile LONG nova_next_directory_descriptor = 0x3fffffffL;

static int nova_owned_directory_handle(int descriptor, HANDLE *output);

static FARPROC WINAPI nova_delay_load_hook(unsigned notification,
                                           PDelayLoadInfo information) {
  if (notification == dliNotePreLoadLibrary && information != NULL &&
      information->szDll != NULL &&
      _stricmp(information->szDll, "node.exe") == 0) {
#pragma warning(push)
#pragma warning(disable : 4055)
    return (FARPROC)(void *)GetModuleHandleW(NULL);
#pragma warning(pop)
  }
  return NULL;
}

const PfnDliHook __pfnDliNotifyHook2 = nova_delay_load_hook;

static napi_value nova_status(napi_env env, const char *status) {
  napi_value result;
  napi_value value;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value) !=
          napi_ok ||
      napi_set_named_property(env, result, "status", value) != napi_ok)
    return NULL;
  return result;
}

static int nova_args(napi_env env, napi_callback_info info, size_t expected,
                     napi_value *args) {
  size_t count = expected;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok)
    return 0;
  return count == expected;
}

static int nova_handle_from_value(napi_env env, napi_value value,
                                  HANDLE *output) {
  int32_t descriptor = -1;
  if (napi_get_value_int32(env, value, &descriptor) != napi_ok ||
      descriptor < 0)
    return 0;
  if (nova_owned_directory_handle(descriptor, output))
    return 1;
  HMODULE executable = GetModuleHandleW(NULL);
  if (executable == NULL)
    return 0;
#pragma warning(push)
#pragma warning(disable : 4055)
  nova_uv_get_osfhandle_fn get_os_handle =
      (nova_uv_get_osfhandle_fn)(void *)GetProcAddress(executable,
                                                     "uv_get_osfhandle");
#pragma warning(pop)
  if (get_os_handle == NULL)
    return 0;
  intptr_t raw = get_os_handle(descriptor);
  if (raw == -1)
    return 0;
  *output = (HANDLE)raw;
  return *output != NULL && *output != INVALID_HANDLE_VALUE;
}

static int nova_basename(napi_env env, napi_value value, WCHAR output[256],
                         USHORT *bytes) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > 255)
    return 0;
  char16_t text[256];
  if (napi_get_value_string_utf16(env, value, text, 256, &length) != napi_ok)
    return 0;
  if ((length == 1 && text[0] == (char16_t)'.') ||
      (length == 2 && text[0] == (char16_t)'.' && text[1] == (char16_t)'.'))
    return 0;
  for (size_t index = 0; index < length; index += 1) {
    uint16_t unit = (uint16_t)text[index];
    if (unit == 0 || unit == (uint16_t)'/' || unit == (uint16_t)'\\' ||
        unit == (uint16_t)':')
      return 0;
    if (unit >= 0xD800U && unit <= 0xDBFFU) {
      if (index + 1 >= length)
        return 0;
      uint16_t next = (uint16_t)text[index + 1];
      if (next < 0xDC00U || next > 0xDFFFU)
        return 0;
      index += 1;
    } else if (unit >= 0xDC00U && unit <= 0xDFFFU)
      return 0;
  }
  for (size_t index = 0; index < length; index += 1)
    output[index] = (WCHAR)text[index];
  output[length] = L'\0';
  *bytes = (USHORT)(length * sizeof(WCHAR));
  return 1;
}

static int nova_current_user(BYTE **token_user) {
  HANDLE token = NULL;
  DWORD required = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    return 0;
  (void)GetTokenInformation(token, TokenUser, NULL, 0, &required);
  if (required == 0) {
    CloseHandle(token);
    return 0;
  }
  BYTE *buffer =
      (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, required);
  if (buffer == NULL ||
      !GetTokenInformation(token, TokenUser, buffer, required, &required)) {
    if (buffer != NULL)
      HeapFree(GetProcessHeap(), 0, buffer);
    CloseHandle(token);
    return 0;
  }
  CloseHandle(token);
  *token_user = buffer;
  return 1;
}

static int nova_owner_only_acl(HANDLE handle) {
  BYTE *token_user = NULL;
  PSECURITY_DESCRIPTOR security = NULL;
  PSID owner = NULL;
  PACL dacl = NULL;
  int valid = 0;
  if (!nova_current_user(&token_user))
    return 0;
  DWORD status =
      GetSecurityInfo(handle, SE_FILE_OBJECT,
                      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                      &owner, NULL, &dacl, NULL, &security);
  if (status != ERROR_SUCCESS || owner == NULL || dacl == NULL ||
      !EqualSid(owner, ((TOKEN_USER *)token_user)->User.Sid))
    goto cleanup;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(security, &control, &revision) ||
      (control & SE_DACL_PROTECTED) == 0)
    goto cleanup;
  ACL_SIZE_INFORMATION size;
  if (!GetAclInformation(dacl, &size, (DWORD)sizeof(size),
                         AclSizeInformation) ||
      size.AceCount == 0) {
    goto cleanup;
  }
  BYTE system_sid[SECURITY_MAX_SID_SIZE];
  BYTE administrators_sid[SECURITY_MAX_SID_SIZE];
  DWORD system_bytes = (DWORD)sizeof(system_sid);
  DWORD administrators_bytes = (DWORD)sizeof(administrators_sid);
  if (!CreateWellKnownSid(WinLocalSystemSid, NULL, system_sid, &system_bytes) ||
      !CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, administrators_sid,
                          &administrators_bytes))
    goto cleanup;
  int owner_allow = 0;
  for (DWORD index = 0; index < size.AceCount; index += 1) {
    void *raw = NULL;
    if (!GetAce(dacl, index, &raw) || raw == NULL)
      goto cleanup;
    ACE_HEADER *header = (ACE_HEADER *)raw;
    if ((header->AceFlags & INHERIT_ONLY_ACE) != 0)
      continue;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE)
      continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE)
      goto cleanup;
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)raw;
    PSID sid = (PSID)&ace->SidStart;
    if (!IsValidSid(sid))
      goto cleanup;
    if (EqualSid(sid, ((TOKEN_USER *)token_user)->User.Sid))
      owner_allow = 1;
    else if (!EqualSid(sid, system_sid) && !EqualSid(sid, administrators_sid))
      goto cleanup;
  }
  valid = owner_allow;

cleanup:
  if (security != NULL)
    LocalFree(security);
  HeapFree(GetProcessHeap(), 0, token_user);
  return valid;
}

static int nova_current_user_owner(HANDLE handle) {
  BYTE *token_user = NULL;
  PSECURITY_DESCRIPTOR security = NULL;
  PSID owner = NULL;
  int valid = 0;
  if (!nova_current_user(&token_user))
    return 0;
  DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT,
                                 OWNER_SECURITY_INFORMATION, &owner, NULL,
                                 NULL, NULL, &security);
  valid = status == ERROR_SUCCESS && owner != NULL &&
          EqualSid(owner, ((TOKEN_USER *)token_user)->User.Sid);
  if (security != NULL)
    LocalFree(security);
  HeapFree(GetProcessHeap(), 0, token_user);
  return valid;
}

static int nova_private_security_create(nova_private_security *output) {
  ZeroMemory(output, sizeof(*output));
  if (!nova_current_user(&output->token_user))
    return 0;
  PSID sid = ((TOKEN_USER *)output->token_user)->User.Sid;
  DWORD acl_bytes = (DWORD)(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) +
                            GetLengthSid(sid) - sizeof(DWORD));
  output->acl = (PACL)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, acl_bytes);
  if (output->acl == NULL ||
      !InitializeAcl(output->acl, acl_bytes, ACL_REVISION) ||
      !AddAccessAllowedAceEx(output->acl, ACL_REVISION, 0, FILE_ALL_ACCESS,
                             sid) ||
      !InitializeSecurityDescriptor(&output->descriptor,
                                    SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&output->descriptor, sid, FALSE) ||
      !SetSecurityDescriptorDacl(&output->descriptor, TRUE, output->acl,
                                 FALSE) ||
      !SetSecurityDescriptorControl(&output->descriptor, SE_DACL_PROTECTED,
                                    SE_DACL_PROTECTED))
    return 0;
  return 1;
}

static void nova_private_security_destroy(nova_private_security *security) {
  if (security->acl != NULL)
    HeapFree(GetProcessHeap(), 0, security->acl);
  if (security->token_user != NULL)
    HeapFree(GetProcessHeap(), 0, security->token_user);
  ZeroMemory(security, sizeof(*security));
}

static int nova_handle_info(HANDLE handle, BY_HANDLE_FILE_INFORMATION *info) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandle(handle, info) ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag,
                                    (DWORD)sizeof(tag)) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
    return 0;
  return 1;
}

static int nova_validate_handle(HANDLE handle, int directory,
                                BY_HANDLE_FILE_INFORMATION *output) {
  BY_HANDLE_FILE_INFORMATION info;
  if (!nova_handle_info(handle, &info))
    return 0;
  int is_directory = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if ((directory == 1 && !is_directory) || (directory == 0 && is_directory) ||
      !nova_owner_only_acl(handle))
    return 0;
  if (output != NULL)
    *output = info;
  return 1;
}

static uint64_t nova_file_index(const BY_HANDLE_FILE_INFORMATION *info) {
  return ((uint64_t)info->nFileIndexHigh << 32U) |
         (uint64_t)info->nFileIndexLow;
}

static int nova_same_identity(const BY_HANDLE_FILE_INFORMATION *left,
                              const BY_HANDLE_FILE_INFORMATION *right) {
  return left->dwVolumeSerialNumber == right->dwVolumeSerialNumber &&
         nova_file_index(left) == nova_file_index(right);
}

static int nova_identity_value(napi_env env,
                               const BY_HANDLE_FILE_INFORMATION *info,
                               napi_value *output) {
  napi_value identity;
  napi_value device;
  napi_value inode;
  if (napi_create_object(env, &identity) != napi_ok ||
      napi_create_bigint_uint64(env, (uint64_t)info->dwVolumeSerialNumber,
                                &device) != napi_ok ||
      napi_create_bigint_uint64(env, nova_file_index(info), &inode) !=
          napi_ok ||
      napi_set_named_property(env, identity, "device", device) != napi_ok ||
      napi_set_named_property(env, identity, "inode", inode) != napi_ok)
    return 0;
  *output = identity;
  return 1;
}

static napi_value nova_identity_result(napi_env env, const char *status,
                                       const BY_HANDLE_FILE_INFORMATION *info) {
  napi_value result = nova_status(env, status);
  napi_value identity;
  if (result == NULL || !nova_identity_value(env, info, &identity) ||
      napi_set_named_property(env, result, "identity", identity) != napi_ok)
    return NULL;
  return result;
}

static int nova_expected_identity(napi_env env, napi_value value,
                                  uint64_t *device, uint64_t *inode) {
  napi_value device_value;
  napi_value inode_value;
  bool lossless_device = false;
  bool lossless_inode = false;
  if (napi_get_named_property(env, value, "device", &device_value) != napi_ok ||
      napi_get_named_property(env, value, "inode", &inode_value) != napi_ok ||
      napi_get_value_bigint_uint64(env, device_value, device,
                                   &lossless_device) != napi_ok ||
      napi_get_value_bigint_uint64(env, inode_value, inode, &lossless_inode) !=
          napi_ok)
    return 0;
  return lossless_device && lossless_inode;
}

static nova_nt_create_file_fn nova_nt_create_file(void) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == NULL)
    return NULL;
#pragma warning(push)
#pragma warning(disable : 4055)
  nova_nt_create_file_fn result =
      (nova_nt_create_file_fn)(void *)GetProcAddress(ntdll, "NtCreateFile");
#pragma warning(pop)
  return result;
}

static nova_nt_set_information_file_fn nova_nt_set_information_file(void) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == NULL)
    return NULL;
#pragma warning(push)
#pragma warning(disable : 4055)
  nova_nt_set_information_file_fn result =
      (nova_nt_set_information_file_fn)(void *)GetProcAddress(
          ntdll, "NtSetInformationFile");
#pragma warning(pop)
  return result;
}

static nova_nt_flush_buffers_file_ex_fn nova_nt_flush_buffers_file_ex(void) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == NULL)
    return NULL;
#pragma warning(push)
#pragma warning(disable : 4055)
  nova_nt_flush_buffers_file_ex_fn result =
      (nova_nt_flush_buffers_file_ex_fn)(void *)GetProcAddress(
          ntdll, "NtFlushBuffersFileEx");
#pragma warning(pop)
  return result;
}

static NTSTATUS nova_open_at(HANDLE root, const WCHAR *name, USHORT name_bytes,
                             ACCESS_MASK access, ULONG disposition,
                             ULONG options, PSECURITY_DESCRIPTOR security,
                             HANDLE *output) {
  nova_nt_create_file_fn create_file = nova_nt_create_file();
  if (create_file == NULL)
    return (NTSTATUS)0xC0000001L;
  UNICODE_STRING relative;
  relative.Buffer = (PWSTR)name;
  relative.Length = name_bytes;
  relative.MaximumLength = (USHORT)(name_bytes + sizeof(WCHAR));
  OBJECT_ATTRIBUTES attributes;
  attributes.Length = (ULONG)sizeof(attributes);
  attributes.RootDirectory = root;
  attributes.ObjectName = &relative;
  attributes.Attributes = OBJ_CASE_INSENSITIVE;
  attributes.SecurityDescriptor = security;
  attributes.SecurityQualityOfService = NULL;
  IO_STATUS_BLOCK io;
  return create_file(output, access | SYNCHRONIZE, &attributes, &io, NULL,
                     FILE_ATTRIBUTE_NORMAL,
                     FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                     disposition,
                     options | FILE_SYNCHRONOUS_IO_NONALERT |
                         FILE_OPEN_REPARSE_POINT | FILE_OPEN_FOR_BACKUP_INTENT,
                     NULL, 0);
}

static int nova_missing_status(NTSTATUS status) {
  return status == NOVA_STATUS_OBJECT_NAME_NOT_FOUND ||
         status == NOVA_STATUS_OBJECT_PATH_NOT_FOUND;
}

static int nova_exists_status(NTSTATUS status) {
  return status == NOVA_STATUS_OBJECT_NAME_COLLISION;
}

static void nova_release_lock(nova_lock_handle *lock) {
  if (lock == NULL || lock->handle == NULL ||
      lock->handle == INVALID_HANDLE_VALUE)
    return;
  HANDLE handle = lock->handle;
  lock->handle = INVALID_HANDLE_VALUE;
  (void)UnlockFileEx(handle, 0, MAXDWORD, MAXDWORD, &lock->range);
  CloseHandle(handle);
}

static void nova_lock_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  nova_lock_handle *lock = (nova_lock_handle *)data;
  nova_release_lock(lock);
  free(lock);
}

static void nova_register_directory(nova_directory_handle *directory) {
  AcquireSRWLockExclusive(&nova_directory_lock);
  directory->next = nova_directories;
  directory->registered = 1;
  nova_directories = directory;
  ReleaseSRWLockExclusive(&nova_directory_lock);
}

static void nova_unregister_directory(nova_directory_handle *directory) {
  AcquireSRWLockExclusive(&nova_directory_lock);
  if (directory->registered) {
    nova_directory_handle **cursor = &nova_directories;
    while (*cursor != NULL && *cursor != directory)
      cursor = &(*cursor)->next;
    if (*cursor == directory)
      *cursor = directory->next;
    directory->registered = 0;
    directory->next = NULL;
  }
  ReleaseSRWLockExclusive(&nova_directory_lock);
}

static int nova_owned_directory_descriptor(napi_env env, napi_value value) {
  int32_t descriptor = -1;
  if (napi_get_value_int32(env, value, &descriptor) != napi_ok ||
      descriptor < 0)
    return 0;
  HANDLE handle;
  return nova_owned_directory_handle(descriptor, &handle);
}

static int nova_owned_directory_handle(int descriptor, HANDLE *output) {
  int owned = 0;
  AcquireSRWLockShared(&nova_directory_lock);
  for (nova_directory_handle *cursor = nova_directories; cursor != NULL;
       cursor = cursor->next) {
    if (cursor->descriptor == descriptor) {
      *output = cursor->handle;
      owned = 1;
      break;
    }
  }
  ReleaseSRWLockShared(&nova_directory_lock);
  return owned;
}

static void nova_release_directory(nova_directory_handle *directory) {
  if (directory == NULL || directory->descriptor < 0)
    return;
  nova_unregister_directory(directory);
  directory->descriptor = -1;
  HANDLE handle = directory->handle;
  directory->handle = INVALID_HANDLE_VALUE;
  if (handle != NULL && handle != INVALID_HANDLE_VALUE)
    CloseHandle(handle);
}

static void nova_directory_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  nova_directory_handle *directory = (nova_directory_handle *)data;
  nova_release_directory(directory);
  free(directory);
}

static napi_value nova_directory_close(napi_env env,
                                       napi_callback_info info) {
  void *data = NULL;
  size_t count = 0;
  if (napi_get_cb_info(env, info, &count, NULL, NULL, &data) == napi_ok)
    nova_release_directory((nova_directory_handle *)data);
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok)
    return NULL;
  return undefined;
}

static size_t nova_trimmed_path_length(const WCHAR *path) {
  size_t length = wcslen(path);
  while (length > 3 &&
         (path[length - 1] == L'\\' || path[length - 1] == L'/'))
    length -= 1;
  return length;
}

static int nova_same_path(const WCHAR *left, const WCHAR *right) {
  size_t left_length = nova_trimmed_path_length(left);
  size_t right_length = nova_trimmed_path_length(right);
  return left_length == right_length &&
         _wcsnicmp(left, right, left_length) == 0;
}

static WCHAR *nova_absolute_path(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > 32767)
    return NULL;
  WCHAR *input =
      (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                         (length + 1) * sizeof(WCHAR));
  if (input == NULL ||
      napi_get_value_string_utf16(env, value, (char16_t *)input, length + 1,
                                  &length) != napi_ok) {
    if (input != NULL)
      HeapFree(GetProcessHeap(), 0, input);
    return NULL;
  }
  for (size_t index = 0; index < length; index += 1) {
    if (input[index] == L'\0') {
      HeapFree(GetProcessHeap(), 0, input);
      return NULL;
    }
  }
  DWORD required = GetFullPathNameW(input, 0, NULL, NULL);
  WCHAR *absolute = required == 0
                        ? NULL
                        : (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                             required * sizeof(WCHAR));
  if (absolute == NULL ||
      GetFullPathNameW(input, required, absolute, NULL) == 0 ||
      !nova_same_path(input, absolute)) {
    if (absolute != NULL)
      HeapFree(GetProcessHeap(), 0, absolute);
    HeapFree(GetProcessHeap(), 0, input);
    return NULL;
  }
  HeapFree(GetProcessHeap(), 0, input);
  return absolute;
}

static WCHAR *nova_final_dos_path(HANDLE handle) {
  DWORD flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
  DWORD required = GetFinalPathNameByHandleW(handle, NULL, 0, flags);
  if (required == 0)
    return NULL;
  WCHAR *native =
      (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                         (required + 1) * sizeof(WCHAR));
  if (native == NULL)
    return NULL;
  DWORD length = GetFinalPathNameByHandleW(handle, native, required + 1, flags);
  if (length == 0 || length > required) {
    HeapFree(GetProcessHeap(), 0, native);
    return NULL;
  }
  const WCHAR unc_prefix[] = L"\\\\?\\UNC\\";
  const WCHAR dos_prefix[] = L"\\\\?\\";
  if (wcsncmp(native, unc_prefix, 8) == 0) {
    size_t tail = wcslen(native + 8);
    WCHAR *converted =
        (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                           (tail + 3) * sizeof(WCHAR));
    if (converted == NULL) {
      HeapFree(GetProcessHeap(), 0, native);
      return NULL;
    }
    converted[0] = L'\\';
    converted[1] = L'\\';
    CopyMemory(converted + 2, native + 8, (tail + 1) * sizeof(WCHAR));
    HeapFree(GetProcessHeap(), 0, native);
    return converted;
  }
  if (wcsncmp(native, dos_prefix, 4) == 0)
    MoveMemory(native, native + 4, (wcslen(native + 4) + 1) * sizeof(WCHAR));
  return native;
}

static napi_value nova_open_directory(napi_env env, napi_callback_info info) {
  napi_value args[1];
  if (!nova_args(env, info, 1, args))
    return nova_status(env, "failed");
  WCHAR *path = nova_absolute_path(env, args[0]);
  if (path == NULL)
    return nova_status(env, "failed");
  DWORD desired = FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY |
                  FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC |
                  FILE_DELETE_CHILD;
  HANDLE opened = CreateFileW(
      path, desired,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (opened == INVALID_HANDLE_VALUE) {
    opened = CreateFileW(
        path,
        FILE_LIST_DIRECTORY | FILE_ADD_SUBDIRECTORY | FILE_READ_ATTRIBUTES |
            READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  }
  if (opened == INVALID_HANDLE_VALUE) {
    opened = CreateFileW(
        path, READ_CONTROL | WRITE_DAC,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  }
  BY_HANDLE_FILE_INFORMATION information;
  WCHAR *final_path = opened == INVALID_HANDLE_VALUE
                          ? NULL
                          : nova_final_dos_path(opened);
  int opened_valid = opened != INVALID_HANDLE_VALUE;
  int final_valid = final_path != NULL;
  int info_valid = opened_valid && nova_handle_info(opened, &information) &&
                   (information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  int path_valid = final_valid && nova_same_path(path, final_path);
  int owner_valid = opened_valid && nova_current_user_owner(opened);
  int valid = opened_valid && final_valid && info_valid && path_valid && owner_valid;
  HeapFree(GetProcessHeap(), 0, path);
  if (final_path != NULL)
    HeapFree(GetProcessHeap(), 0, final_path);
  if (!valid) {
    if (opened != INVALID_HANDLE_VALUE)
      CloseHandle(opened);
    return nova_status(env, "failed");
  }
  LONG descriptor = InterlockedIncrement(&nova_next_directory_descriptor);
  if (descriptor <= 0 || descriptor > INT32_MAX) {
    CloseHandle(opened);
    return nova_status(env, "failed");
  }
  nova_directory_handle *directory =
      (nova_directory_handle *)calloc(1, sizeof(*directory));
  if (directory == NULL) {
    CloseHandle(opened);
    return nova_status(env, "failed");
  }
  directory->descriptor = (int)descriptor;
  directory->handle = opened;
  nova_register_directory(directory);
  napi_value result = nova_status(env, "ok");
  napi_value descriptor_value;
  napi_value close;
  napi_value owner;
  if (result == NULL ||
      napi_create_int32(env, (int32_t)descriptor, &descriptor_value) != napi_ok ||
      napi_create_function(env, "close", NAPI_AUTO_LENGTH,
                           nova_directory_close, directory, &close) != napi_ok ||
      napi_create_external(env, directory, nova_directory_finalize, NULL,
                           &owner) != napi_ok) {
    nova_release_directory(directory);
    free(directory);
    return nova_status(env, "failed");
  }
  if (napi_set_named_property(env, close, "__nova_directory_owner", owner) !=
          napi_ok ||
      napi_set_named_property(env, result, "descriptor", descriptor_value) !=
          napi_ok ||
      napi_set_named_property(env, result, "close", close) != napi_ok) {
    nova_release_directory(directory);
    return NULL;
  }
  return result;
}

static napi_value nova_lock_release(napi_env env, napi_callback_info info) {
  void *data = NULL;
  size_t count = 0;
  if (napi_get_cb_info(env, info, &count, NULL, NULL, &data) == napi_ok) {
    nova_release_lock((nova_lock_handle *)data);
  }
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok)
    return NULL;
  return undefined;
}

static napi_value nova_acquire(napi_env env, napi_callback_info info) {
  napi_value args[1];
  HANDLE borrowed;
  BY_HANDLE_FILE_INFORMATION file;
  if (!nova_args(env, info, 1, args) ||
      !nova_handle_from_value(env, args[0], &borrowed) ||
      !nova_validate_handle(borrowed, 0, &file))
    return nova_status(env, "failed");
  HANDLE retained = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), borrowed, GetCurrentProcess(),
                       &retained, 0, FALSE, DUPLICATE_SAME_ACCESS))
    return nova_status(env, "failed");
  nova_lock_handle *lock = (nova_lock_handle *)calloc(1, sizeof(*lock));
  if (lock == NULL) {
    CloseHandle(retained);
    return nova_status(env, "failed");
  }
  lock->handle = retained;
  ZeroMemory(&lock->range, sizeof(lock->range));
  if (!LockFileEx(retained, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                  0, MAXDWORD, MAXDWORD, &lock->range)) {
    DWORD error = GetLastError();
    CloseHandle(retained);
    free(lock);
    return nova_status(env, error == ERROR_LOCK_VIOLATION ||
                                    error == ERROR_IO_PENDING
                                ? "busy"
                                : "failed");
  }
  napi_value result = nova_status(env, "acquired");
  napi_value release;
  napi_value owner;
  if (result == NULL ||
      napi_create_function(env, "release", NAPI_AUTO_LENGTH, nova_lock_release,
                           lock, &release) != napi_ok ||
      napi_create_external(env, lock, nova_lock_finalize, NULL, &owner) !=
          napi_ok) {
    nova_release_lock(lock);
    free(lock);
    return nova_status(env, "failed");
  }
  if (napi_set_named_property(env, release, "__nova_lock_owner", owner) !=
          napi_ok ||
      napi_set_named_property(env, result, "release", release) != napi_ok)
    return nova_status(env, "failed");
  return result;
}

static napi_value nova_probe(napi_env env, napi_callback_info info) {
  napi_value args[1];
  HANDLE root;
  if (!nova_args(env, info, 1, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_validate_handle(root, 1, NULL))
    return nova_status(env, "failed");
  return nova_status(env, "ok");
}

static int nova_protect_directory_handle(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION before;
  nova_private_security security;
  ZeroMemory(&security, sizeof(security));
  int valid = nova_handle_info(handle, &before) &&
              (before.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
              nova_private_security_create(&security);
  if (valid) {
    DWORD status = SetSecurityInfo(
        handle, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        NULL, NULL, security.acl, NULL);
    BY_HANDLE_FILE_INFORMATION after;
    valid = status == ERROR_SUCCESS && nova_validate_handle(handle, 1, &after) &&
            nova_same_identity(&before, &after);
  }
  nova_private_security_destroy(&security);
  return valid;
}

static napi_value nova_protect_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  HANDLE root;
  HANDLE child;
  WCHAR name[256];
  USHORT name_bytes;
  BY_HANDLE_FILE_INFORMATION root_info;
  BY_HANDLE_FILE_INFORMATION expected;
  if (!nova_args(env, info, 3, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_handle_info(root, &root_info) ||
      (root_info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (!nova_owned_directory_descriptor(env, args[0]) &&
       !nova_current_user_owner(root)) ||
      !nova_basename(env, args[1], name, &name_bytes) ||
      !nova_handle_from_value(env, args[2], &child) ||
      !nova_handle_info(child, &expected) ||
      (expected.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      !nova_current_user_owner(child))
    return nova_status(env, "failed");
  HANDLE opened = INVALID_HANDLE_VALUE;
  NTSTATUS status = nova_open_at(
      root, name, name_bytes, FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC,
      FILE_OPEN, FILE_DIRECTORY_FILE, NULL, &opened);
  BY_HANDLE_FILE_INFORMATION actual;
  int valid = status == NOVA_STATUS_SUCCESS &&
              nova_handle_info(opened, &actual) &&
              nova_same_identity(&expected, &actual) &&
              nova_protect_directory_handle(opened);
  if (opened != INVALID_HANDLE_VALUE)
    CloseHandle(opened);
  return nova_status(env, valid ? "ok" : "failed");
}

static napi_value nova_matches_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  HANDLE root;
  HANDLE child;
  WCHAR name[256];
  USHORT name_bytes;
  BY_HANDLE_FILE_INFORMATION expected;
  BY_HANDLE_FILE_INFORMATION actual;
  if (!nova_args(env, info, 3, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_validate_handle(root, 1, NULL) ||
      !nova_basename(env, args[1], name, &name_bytes) ||
      !nova_handle_from_value(env, args[2], &child) ||
      !nova_validate_handle(child, -1, &expected)) {
    return nova_status(env, "failed");
  }
  HANDLE opened = INVALID_HANDLE_VALUE;
  NTSTATUS status =
      nova_open_at(root, name, name_bytes, FILE_READ_ATTRIBUTES | READ_CONTROL,
                   FILE_OPEN, 0, NULL, &opened);
  if (status != NOVA_STATUS_SUCCESS ||
      !nova_validate_handle(opened, -1, &actual)) {
    if (opened != INVALID_HANDLE_VALUE)
      CloseHandle(opened);
    return nova_status(env, "failed");
  }
  CloseHandle(opened);
  return nova_status(env, nova_same_identity(&expected, &actual) ? "ok"
                                                                 : "mismatch");
}

static napi_value nova_lookup_at(napi_env env, napi_callback_info info) {
  napi_value args[2];
  HANDLE root;
  WCHAR name[256];
  USHORT name_bytes;
  if (!nova_args(env, info, 2, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_validate_handle(root, 1, NULL) ||
      !nova_basename(env, args[1], name, &name_bytes))
    return nova_status(env, "failed");
  HANDLE opened = INVALID_HANDLE_VALUE;
  NTSTATUS status =
      nova_open_at(root, name, name_bytes, FILE_READ_ATTRIBUTES | READ_CONTROL,
                   FILE_OPEN, 0, NULL, &opened);
  if (nova_missing_status(status))
    return nova_status(env, "missing");
  BY_HANDLE_FILE_INFORMATION actual;
  if (status != NOVA_STATUS_SUCCESS ||
      !nova_validate_handle(opened, -1, &actual)) {
    if (opened != INVALID_HANDLE_VALUE)
      CloseHandle(opened);
    return nova_status(env, "failed");
  }
  CloseHandle(opened);
  return nova_identity_result(env, "ok", &actual);
}

static napi_value nova_create_at(napi_env env, napi_callback_info info,
                                 int directory) {
  napi_value args[3];
  HANDLE root;
  WCHAR name[256];
  USHORT name_bytes;
  bool exclusive = false;
  size_t expected_args = directory ? 2U : 3U;
  if (!nova_args(env, info, expected_args, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_validate_handle(root, 1, NULL) ||
      !nova_basename(env, args[1], name, &name_bytes) ||
      (!directory &&
       napi_get_value_bool(env, args[2], &exclusive) != napi_ok)) {
    return nova_status(env, "failed");
  }
  (void)exclusive;
  nova_private_security security;
  if (!nova_private_security_create(&security)) {
    nova_private_security_destroy(&security);
    return nova_status(env, "failed");
  }
  HANDLE opened = INVALID_HANDLE_VALUE;
  ULONG options = directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE;
  NTSTATUS status = nova_open_at(
      root, name, name_bytes,
      FILE_READ_ATTRIBUTES | READ_CONTROL | DELETE |
          (directory ? FILE_LIST_DIRECTORY : (GENERIC_READ | GENERIC_WRITE)),
      FILE_CREATE, options, &security.descriptor, &opened);
  nova_private_security_destroy(&security);
  if (nova_exists_status(status))
    return nova_status(env, "exists");
  BY_HANDLE_FILE_INFORMATION actual;
  if (status != NOVA_STATUS_SUCCESS ||
      !nova_validate_handle(opened, directory, &actual)) {
    if (opened != INVALID_HANDLE_VALUE)
      CloseHandle(opened);
    return nova_status(env, "failed");
  }
  CloseHandle(opened);
  return nova_identity_result(env, "ok", &actual);
}

static napi_value nova_create_file_at(napi_env env, napi_callback_info info) {
  return nova_create_at(env, info, 0);
}

static napi_value nova_mkdir_at(napi_env env, napi_callback_info info) {
  return nova_create_at(env, info, 1);
}

static napi_value nova_mkdir_private_at(napi_env env,
                                        napi_callback_info info) {
  napi_value args[2];
  HANDLE root;
  WCHAR name[256];
  USHORT name_bytes;
  BY_HANDLE_FILE_INFORMATION root_info;
  if (!nova_args(env, info, 2, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_handle_info(root, &root_info) ||
      (root_info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (!nova_owned_directory_descriptor(env, args[0]) &&
       !nova_current_user_owner(root)) ||
      !nova_basename(env, args[1], name, &name_bytes))
    return nova_status(env, "failed");
  nova_private_security security;
  if (!nova_private_security_create(&security)) {
    nova_private_security_destroy(&security);
    return nova_status(env, "failed");
  }
  HANDLE opened = INVALID_HANDLE_VALUE;
  NTSTATUS status = nova_open_at(
      root, name, name_bytes,
      FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | FILE_LIST_DIRECTORY,
      FILE_CREATE, FILE_DIRECTORY_FILE, &security.descriptor, &opened);
  nova_private_security_destroy(&security);
  if (nova_exists_status(status))
    return nova_status(env, "exists");
  BY_HANDLE_FILE_INFORMATION actual;
  if (status != NOVA_STATUS_SUCCESS ||
      !nova_validate_handle(opened, 1, &actual)) {
    if (opened != INVALID_HANDLE_VALUE)
      CloseHandle(opened);
    return nova_status(env, "failed");
  }
  CloseHandle(opened);
  return nova_identity_result(env, "ok", &actual);
}

static napi_value nova_rename_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  HANDLE root;
  WCHAR from[256];
  WCHAR to[256];
  USHORT from_bytes;
  USHORT to_bytes;
  if (!nova_args(env, info, 3, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_validate_handle(root, 1, NULL) ||
      !nova_basename(env, args[1], from, &from_bytes) ||
      !nova_basename(env, args[2], to, &to_bytes))
    return nova_status(env, "failed");
  HANDLE opened = INVALID_HANDLE_VALUE;
  NTSTATUS status = nova_open_at(root, from, from_bytes,
                                 DELETE | FILE_READ_ATTRIBUTES | READ_CONTROL,
                                 FILE_OPEN, 0, NULL, &opened);
  if (status != NOVA_STATUS_SUCCESS ||
      !nova_validate_handle(opened, -1, NULL)) {
    if (opened != INVALID_HANDLE_VALUE)
      CloseHandle(opened);
    return nova_status(env, "failed");
  }
  SIZE_T bytes = FIELD_OFFSET(FILE_RENAME_INFO, FileName) + to_bytes + sizeof(WCHAR);
  FILE_RENAME_INFO *rename =
      (FILE_RENAME_INFO *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes);
  if (rename == NULL) {
    CloseHandle(opened);
    return nova_status(env, "failed");
  }
  rename->ReplaceIfExists = TRUE;
  rename->RootDirectory = root;
  rename->FileNameLength = to_bytes;
  CopyMemory(rename->FileName, to, to_bytes);
  nova_nt_set_information_file_fn set_information = nova_nt_set_information_file();
  IO_STATUS_BLOCK io;
  NTSTATUS rename_status = set_information == NULL
                               ? (NTSTATUS)0xC0000001L
                               : set_information(opened, &io, rename,
                                                 (ULONG)bytes,
                                                 NOVA_FILE_RENAME_INFORMATION);
  HeapFree(GetProcessHeap(), 0, rename);
  CloseHandle(opened);
  return nova_status(env, rename_status == NOVA_STATUS_SUCCESS ? "ok" : "failed");
}

static napi_value nova_rename_no_replace_at(napi_env env,
                                             napi_callback_info info) {
  napi_value args[4];
  HANDLE root;
  WCHAR from[256];
  WCHAR to[256];
  USHORT from_bytes;
  USHORT to_bytes;
  uint64_t device;
  uint64_t inode;
  if (!nova_args(env, info, 4, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_validate_handle(root, 1, NULL) ||
      !nova_basename(env, args[1], from, &from_bytes) ||
      !nova_basename(env, args[2], to, &to_bytes) ||
      !nova_expected_identity(env, args[3], &device, &inode))
    return nova_status(env, "failed");
  HANDLE opened = INVALID_HANDLE_VALUE;
  NTSTATUS status = nova_open_at(root, from, from_bytes,
                                 DELETE | FILE_READ_ATTRIBUTES | READ_CONTROL,
                                 FILE_OPEN, 0, NULL, &opened);
  if (nova_missing_status(status)) return nova_status(env, "missing");
  BY_HANDLE_FILE_INFORMATION actual;
  if (status != NOVA_STATUS_SUCCESS ||
      !nova_validate_handle(opened, -1, &actual)) {
    if (opened != INVALID_HANDLE_VALUE) CloseHandle(opened);
    return nova_status(env, "failed");
  }
  if ((uint64_t)actual.dwVolumeSerialNumber != device ||
      nova_file_index(&actual) != inode) {
    CloseHandle(opened);
    return nova_status(env, "mismatch");
  }
  SIZE_T bytes = FIELD_OFFSET(FILE_RENAME_INFO, FileName) + to_bytes + sizeof(WCHAR);
  FILE_RENAME_INFO *rename =
      (FILE_RENAME_INFO *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes);
  if (rename == NULL) {
    CloseHandle(opened);
    return nova_status(env, "failed");
  }
  rename->ReplaceIfExists = FALSE;
  rename->RootDirectory = root;
  rename->FileNameLength = to_bytes;
  CopyMemory(rename->FileName, to, to_bytes);
  nova_nt_set_information_file_fn set_information = nova_nt_set_information_file();
  IO_STATUS_BLOCK io;
  NTSTATUS rename_status = set_information == NULL
                               ? (NTSTATUS)0xC0000001L
                               : set_information(opened, &io, rename,
                                                 (ULONG)bytes,
                                                 NOVA_FILE_RENAME_INFORMATION);
  HeapFree(GetProcessHeap(), 0, rename);
  CloseHandle(opened);
  if (rename_status == NOVA_STATUS_SUCCESS) return nova_status(env, "ok");
  if (nova_exists_status(rename_status)) return nova_status(env, "exists");
  if (nova_missing_status(rename_status)) return nova_status(env, "missing");
  return nova_status(env, "failed");
}

static napi_value nova_sync_directory(napi_env env, napi_callback_info info) {
  napi_value args[1];
  HANDLE root;
  if (!nova_args(env, info, 1, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_validate_handle(root, 1, NULL)) return nova_status(env, "failed");
  nova_nt_flush_buffers_file_ex_fn flush = nova_nt_flush_buffers_file_ex();
  IO_STATUS_BLOCK io;
  NTSTATUS status = flush == NULL
                        ? (NTSTATUS)0xC0000001L
                        : flush(root, 0, NULL, 0, &io);
  return nova_status(env, status == NOVA_STATUS_SUCCESS ? "ok" : "failed");
}

static napi_value nova_unlink_at(napi_env env, napi_callback_info info) {
  napi_value args[4];
  HANDLE root;
  WCHAR name[256];
  WCHAR kind[16];
  USHORT name_bytes;
  size_t kind_length = 0;
  uint64_t device;
  uint64_t inode;
  if (!nova_args(env, info, 4, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_validate_handle(root, 1, NULL) ||
      !nova_basename(env, args[1], name, &name_bytes) ||
      !nova_expected_identity(env, args[2], &device, &inode) ||
      napi_get_value_string_utf16(env, args[3], (char16_t *)kind, 16,
                                  &kind_length) != napi_ok ||
      kind_length >= 16)
    return nova_status(env, "failed");
  int expected_directory;
  if (wcscmp(kind, L"file") == 0)
    expected_directory = 0;
  else if (wcscmp(kind, L"directory") == 0)
    expected_directory = 1;
  else
    return nova_status(env, "failed");
  HANDLE opened = INVALID_HANDLE_VALUE;
  NTSTATUS status = nova_open_at(root, name, name_bytes,
                                 DELETE | FILE_READ_ATTRIBUTES | READ_CONTROL,
                                 FILE_OPEN, 0, NULL, &opened);
  if (nova_missing_status(status))
    return nova_status(env, "missing");
  BY_HANDLE_FILE_INFORMATION actual;
  if (status != NOVA_STATUS_SUCCESS ||
      !nova_validate_handle(opened, expected_directory, &actual)) {
    if (opened != INVALID_HANDLE_VALUE)
      CloseHandle(opened);
    return nova_status(env, "failed");
  }
  if ((uint64_t)actual.dwVolumeSerialNumber != device ||
      nova_file_index(&actual) != inode) {
    CloseHandle(opened);
    return nova_status(env, "mismatch");
  }
  nova_file_disposition_info_ex disposition = {
      FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS |
      FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE};
  BOOL removed = SetFileInformationByHandle(
      opened, FileDispositionInfoEx, &disposition, (DWORD)sizeof(disposition));
  if (!removed) {
    FILE_DISPOSITION_INFO fallback = {TRUE};
    removed = SetFileInformationByHandle(opened, FileDispositionInfo, &fallback,
                                         (DWORD)sizeof(fallback));
  }
  CloseHandle(opened);
  return nova_status(env, removed ? "ok" : "failed");
}

static int nova_delete_handle(HANDLE opened) {
  nova_file_disposition_info_ex disposition = {
      FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS |
      FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE};
  if (SetFileInformationByHandle(opened, FileDispositionInfoEx, &disposition,
                                 (DWORD)sizeof(disposition)))
    return 1;
  FILE_DISPOSITION_INFO fallback = {TRUE};
  return SetFileInformationByHandle(opened, FileDispositionInfo, &fallback,
                                    (DWORD)sizeof(fallback));
}

static int nova_raw_handle_info(HANDLE handle,
                                BY_HANDLE_FILE_INFORMATION *information,
                                int *reparse) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandle(handle, information) ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag,
                                    (DWORD)sizeof(tag)))
    return 0;
  *reparse = (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  return 1;
}

static int nova_dot_name(const WCHAR *name, size_t length) {
  return (length == 1 && name[0] == L'.') ||
         (length == 2 && name[0] == L'.' && name[1] == L'.');
}

static int nova_remove_tree_contents(HANDLE directory, unsigned depth) {
  for (;;) {
    BYTE *buffer = (BYTE *)HeapAlloc(GetProcessHeap(), 0,
                                     NOVA_DIRECTORY_ENUM_BUFFER_BYTES);
    if (buffer == NULL)
      return 0;
    if (!GetFileInformationByHandleEx(
            directory, FileIdBothDirectoryRestartInfo, buffer,
            (DWORD)NOVA_DIRECTORY_ENUM_BUFFER_BYTES)) {
      DWORD error = GetLastError();
      HeapFree(GetProcessHeap(), 0, buffer);
      return error == ERROR_NO_MORE_FILES;
    }
    FILE_ID_BOTH_DIR_INFO *entry = (FILE_ID_BOTH_DIR_INFO *)buffer;
    WCHAR name[256];
    USHORT name_bytes = 0;
    uint64_t file_id = 0;
    int selected = 0;
    for (;;) {
      size_t length = (size_t)entry->FileNameLength / sizeof(WCHAR);
      if (!nova_dot_name(entry->FileName, length)) {
        if (length == 0 || length > 255) {
          HeapFree(GetProcessHeap(), 0, buffer);
          return 0;
        }
        CopyMemory(name, entry->FileName, entry->FileNameLength);
        name[length] = L'\0';
        name_bytes = (USHORT)entry->FileNameLength;
        file_id = (uint64_t)entry->FileId.QuadPart;
        selected = 1;
        break;
      }
      if (entry->NextEntryOffset == 0) break;
      entry = (FILE_ID_BOTH_DIR_INFO *)((BYTE *)entry + entry->NextEntryOffset);
    }
    HeapFree(GetProcessHeap(), 0, buffer);
    if (!selected)
      return 1;

    HANDLE child = INVALID_HANDLE_VALUE;
    NTSTATUS status = nova_open_at(
        directory, name, name_bytes,
        DELETE | FILE_READ_ATTRIBUTES | READ_CONTROL | FILE_LIST_DIRECTORY,
        FILE_OPEN, 0, NULL, &child);
    if (status != NOVA_STATUS_SUCCESS)
      return 0;
    BY_HANDLE_FILE_INFORMATION child_info;
    int reparse = 0;
    if (!nova_raw_handle_info(child, &child_info, &reparse) ||
        nova_file_index(&child_info) != file_id) {
      CloseHandle(child);
      return 0;
    }
    int child_directory =
        (child_info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    int removed = 0;
    if (child_directory && !reparse) {
      if (depth < NOVA_REMOVE_TREE_MAX_DEPTH) {
        removed = nova_remove_tree_contents(child, depth + 1) &&
                  nova_delete_handle(child);
      }
    } else {
      /* Reparse points are selected and deleted as leaves; never traverse. */
      removed = nova_delete_handle(child);
    }
    CloseHandle(child);
    if (!removed)
      return 0;
  }
}

static napi_value nova_remove_tree_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  HANDLE root;
  WCHAR name[256];
  USHORT name_bytes;
  uint64_t device;
  uint64_t inode;
  if (!nova_args(env, info, 3, args) ||
      !nova_handle_from_value(env, args[0], &root) ||
      !nova_validate_handle(root, 1, NULL) ||
      !nova_basename(env, args[1], name, &name_bytes) ||
      !nova_expected_identity(env, args[2], &device, &inode))
    return nova_status(env, "failed");
  HANDLE opened = INVALID_HANDLE_VALUE;
  NTSTATUS status = nova_open_at(
      root, name, name_bytes,
      DELETE | FILE_READ_ATTRIBUTES | READ_CONTROL | FILE_LIST_DIRECTORY,
      FILE_OPEN, FILE_DIRECTORY_FILE, NULL, &opened);
  if (nova_missing_status(status)) return nova_status(env, "missing");
  BY_HANDLE_FILE_INFORMATION actual;
  if (status != NOVA_STATUS_SUCCESS || !nova_validate_handle(opened, 1, &actual)) {
    if (opened != INVALID_HANDLE_VALUE) CloseHandle(opened);
    return nova_status(env, "mismatch");
  }
  if ((uint64_t)actual.dwVolumeSerialNumber != device ||
      nova_file_index(&actual) != inode) {
    CloseHandle(opened);
    return nova_status(env, "mismatch");
  }
  int removed =
      nova_remove_tree_contents(opened, 0) && nova_delete_handle(opened);
  CloseHandle(opened);
  return nova_status(env, removed ? "ok" : "failed");
}

static int nova_export(napi_env env, napi_value exports, const char *name,
                       napi_callback callback) {
  napi_value function;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL,
                              &function) == napi_ok &&
         napi_set_named_property(env, exports, name, function) == napi_ok;
}

NAPI_MODULE_INIT() {
  if (!nova_export(env, exports, "acquire", nova_acquire) ||
      !nova_export(env, exports, "openDirectory", nova_open_directory) ||
      !nova_export(env, exports, "probe", nova_probe) ||
      !nova_export(env, exports, "matchesAt", nova_matches_at) ||
      !nova_export(env, exports, "lookupAt", nova_lookup_at) ||
      !nova_export(env, exports, "createFileAt", nova_create_file_at) ||
      !nova_export(env, exports, "mkdirAt", nova_mkdir_at) ||
      !nova_export(env, exports, "mkdirPrivateAt", nova_mkdir_private_at) ||
      !nova_export(env, exports, "protectAt", nova_protect_at) ||
      !nova_export(env, exports, "renameAt", nova_rename_at) ||
      !nova_export(env, exports, "renameNoReplaceAt", nova_rename_no_replace_at) ||
      !nova_export(env, exports, "syncDirectory", nova_sync_directory) ||
      !nova_export(env, exports, "unlinkAt", nova_unlink_at) ||
      !nova_export(env, exports, "removeTreeAt", nova_remove_tree_at))
    return NULL;
  return exports;
}
