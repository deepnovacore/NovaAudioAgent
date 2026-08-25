#define _DARWIN_C_SOURCE 1
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif

typedef struct {
  int descriptor;
} nova_lock_handle;

static napi_value nova_status(napi_env env, const char* status) {
  napi_value result;
  napi_value value;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, result, "status", value) != napi_ok) {
    return NULL;
  }
  return result;
}

static int nova_descriptor(napi_env env, napi_value value, int* descriptor) {
  int32_t candidate;
  if (napi_get_value_int32(env, value, &candidate) != napi_ok || candidate < 0) return 0;
  *descriptor = (int)candidate;
  return 1;
}

static int nova_basename(napi_env env, napi_value value, char output[256]) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > 255) return 0;
  if (napi_get_value_string_utf8(env, value, output, 256, &length) != napi_ok) return 0;
  output[length] = '\0';
  if (strcmp(output, ".") == 0 || strcmp(output, "..") == 0) return 0;
  if (strstr(output, "://") != NULL) return 0;
  for (size_t index = 0; index < length; index += 1) {
    if (output[index] == '/' || output[index] == '\\' || output[index] == ':' ||
        output[index] == '\0') return 0;
  }
  return 1;
}

static int nova_identity_value(napi_env env, const struct stat* info, napi_value* output) {
  napi_value identity;
  napi_value device;
  napi_value inode;
  if (napi_create_object(env, &identity) != napi_ok ||
      napi_create_bigint_uint64(env, (uint64_t)info->st_dev, &device) != napi_ok ||
      napi_create_bigint_uint64(env, (uint64_t)info->st_ino, &inode) != napi_ok ||
      napi_set_named_property(env, identity, "device", device) != napi_ok ||
      napi_set_named_property(env, identity, "inode", inode) != napi_ok) return 0;
  *output = identity;
  return 1;
}

static napi_value nova_identity_result(napi_env env, const char* status, const struct stat* info) {
  napi_value result = nova_status(env, status);
  napi_value identity;
  if (result == NULL || !nova_identity_value(env, info, &identity) ||
      napi_set_named_property(env, result, "identity", identity) != napi_ok) return NULL;
  return result;
}

static int nova_expected_identity(
    napi_env env,
    napi_value value,
    uint64_t* device,
    uint64_t* inode) {
  napi_value device_value;
  napi_value inode_value;
  bool lossless_device = false;
  bool lossless_inode = false;
  if (napi_get_named_property(env, value, "device", &device_value) != napi_ok ||
      napi_get_named_property(env, value, "inode", &inode_value) != napi_ok ||
      napi_get_value_bigint_uint64(env, device_value, device, &lossless_device) != napi_ok ||
      napi_get_value_bigint_uint64(env, inode_value, inode, &lossless_inode) != napi_ok) return 0;
  return lossless_device && lossless_inode;
}

static int nova_args(
    napi_env env,
    napi_callback_info info,
    size_t expected,
    napi_value* args) {
  size_t count = expected;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok) return 0;
  return count == expected;
}

static void nova_release_lock(nova_lock_handle* handle) {
  if (handle == NULL || handle->descriptor < 0) return;
  int descriptor = handle->descriptor;
  handle->descriptor = -1;
  (void)flock(descriptor, LOCK_UN);
  (void)close(descriptor);
}

static void nova_lock_finalize(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  nova_lock_handle* handle = (nova_lock_handle*)data;
  nova_release_lock(handle);
  free(handle);
}

static napi_value nova_lock_release(napi_env env, napi_callback_info info) {
  void* data = NULL;
  size_t count = 0;
  if (napi_get_cb_info(env, info, &count, NULL, NULL, &data) == napi_ok) {
    nova_release_lock((nova_lock_handle*)data);
  }
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok) return NULL;
  return undefined;
}

static napi_value nova_acquire(napi_env env, napi_callback_info info) {
  napi_value args[1];
  int descriptor;
  struct stat descriptor_info;
  if (!nova_args(env, info, 1, args) || !nova_descriptor(env, args[0], &descriptor) ||
      fstat(descriptor, &descriptor_info) != 0 || !S_ISREG(descriptor_info.st_mode) ||
      descriptor_info.st_uid != geteuid()) return nova_status(env, "failed");
  int retained = dup(descriptor);
  if (retained < 0) return nova_status(env, "failed");
  if (flock(retained, LOCK_EX | LOCK_NB) != 0) {
    int lock_error = errno;
    (void)close(retained);
    return nova_status(env, lock_error == EWOULDBLOCK || lock_error == EAGAIN ? "busy" : "failed");
  }

  nova_lock_handle* handle = (nova_lock_handle*)calloc(1, sizeof(nova_lock_handle));
  if (handle == NULL) {
    (void)flock(retained, LOCK_UN);
    (void)close(retained);
    return nova_status(env, "failed");
  }
  handle->descriptor = retained;
  napi_value result = nova_status(env, "acquired");
  napi_value release;
  napi_value owner;
  if (result == NULL ||
      napi_create_function(env, "release", NAPI_AUTO_LENGTH, nova_lock_release, handle, &release) != napi_ok ||
      napi_create_external(env, handle, nova_lock_finalize, NULL, &owner) != napi_ok) {
    nova_release_lock(handle);
    free(handle);
    return nova_status(env, "failed");
  }
  /* From this point the external owns the handle even if property attachment fails. */
  if (napi_set_named_property(env, release, "__nova_lock_owner", owner) != napi_ok ||
      napi_set_named_property(env, result, "release", release) != napi_ok) return nova_status(env, "failed");
  return result;
}

static napi_value nova_probe(napi_env env, napi_callback_info info) {
  napi_value args[1];
  int descriptor;
  struct stat root;
  if (!nova_args(env, info, 1, args) || !nova_descriptor(env, args[0], &descriptor) ||
      fstat(descriptor, &root) != 0 || !S_ISDIR(root.st_mode) || root.st_uid != geteuid() ||
      (root.st_mode & 0022) != 0) return nova_status(env, "failed");
  return nova_status(env, "ok");
}

static int nova_protect_descriptor(int descriptor) {
  struct stat before;
  int valid = fstat(descriptor, &before) == 0 && S_ISDIR(before.st_mode) &&
      before.st_uid == geteuid() && fchmod(descriptor, 0700) == 0;
  struct stat after;
  valid = valid && fstat(descriptor, &after) == 0 && S_ISDIR(after.st_mode) &&
      after.st_dev == before.st_dev && after.st_ino == before.st_ino &&
      after.st_uid == geteuid() && (after.st_mode & 0777) == 0700;
  return valid;
}

static napi_value nova_protect_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  int root_descriptor;
  int child_descriptor;
  char name[256];
  struct stat root;
  struct stat expected;
  if (!nova_args(env, info, 3, args) ||
      !nova_descriptor(env, args[0], &root_descriptor) ||
      fstat(root_descriptor, &root) != 0 || !S_ISDIR(root.st_mode) ||
      root.st_uid != geteuid() ||
      !nova_basename(env, args[1], name) ||
      !nova_descriptor(env, args[2], &child_descriptor) ||
      fstat(child_descriptor, &expected) != 0 || !S_ISDIR(expected.st_mode) ||
      expected.st_uid != geteuid()) return nova_status(env, "failed");
  int opened = openat(root_descriptor, name,
                      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (opened < 0) return nova_status(env, "failed");
  struct stat actual;
  int valid = fstat(opened, &actual) == 0 && S_ISDIR(actual.st_mode) &&
      actual.st_dev == expected.st_dev && actual.st_ino == expected.st_ino &&
      nova_protect_descriptor(opened);
  (void)close(opened);
  return nova_status(env, valid ? "ok" : "failed");
}

static napi_value nova_matches_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  int root_descriptor;
  int child_descriptor;
  char name[256];
  struct stat expected;
  struct stat actual;
  if (!nova_args(env, info, 3, args) ||
      !nova_descriptor(env, args[0], &root_descriptor) ||
      !nova_basename(env, args[1], name) ||
      !nova_descriptor(env, args[2], &child_descriptor) ||
      fstat(child_descriptor, &expected) != 0 ||
      fstatat(root_descriptor, name, &actual, AT_SYMLINK_NOFOLLOW) != 0) {
    return nova_status(env, "failed");
  }
  if (S_ISLNK(actual.st_mode) || actual.st_dev != expected.st_dev || actual.st_ino != expected.st_ino) {
    return nova_status(env, "mismatch");
  }
  return nova_status(env, "ok");
}

static napi_value nova_lookup_at(napi_env env, napi_callback_info info) {
  napi_value args[2];
  int root_descriptor;
  char name[256];
  struct stat actual;
  if (!nova_args(env, info, 2, args) ||
      !nova_descriptor(env, args[0], &root_descriptor) ||
      !nova_basename(env, args[1], name)) return nova_status(env, "failed");
  if (fstatat(root_descriptor, name, &actual, AT_SYMLINK_NOFOLLOW) != 0) {
    return nova_status(env, errno == ENOENT ? "missing" : "failed");
  }
  if (S_ISLNK(actual.st_mode)) return nova_status(env, "failed");
  return nova_identity_result(env, "ok", &actual);
}

static napi_value nova_create_file_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  int root_descriptor;
  char name[256];
  bool exclusive;
  if (!nova_args(env, info, 3, args) ||
      !nova_descriptor(env, args[0], &root_descriptor) ||
      !nova_basename(env, args[1], name) ||
      napi_get_value_bool(env, args[2], &exclusive) != napi_ok) return nova_status(env, "failed");
  int descriptor = openat(
      root_descriptor,
      name,
      O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      0600);
  if (descriptor < 0) {
    if (errno == EEXIST) return nova_status(env, "exists");
    return nova_status(env, "failed");
  }
  struct stat actual;
  int stat_result = fstat(descriptor, &actual);
  int close_result = close(descriptor);
  if (stat_result != 0 || close_result != 0 || !S_ISREG(actual.st_mode) ||
      actual.st_uid != geteuid() || (actual.st_mode & 0777) != 0600) {
    (void)unlinkat(root_descriptor, name, 0);
    return nova_status(env, "failed");
  }
  (void)exclusive;
  return nova_identity_result(env, "ok", &actual);
}

static napi_value nova_mkdir_at(napi_env env, napi_callback_info info) {
  napi_value args[2];
  int root_descriptor;
  char name[256];
  if (!nova_args(env, info, 2, args) ||
      !nova_descriptor(env, args[0], &root_descriptor) ||
      !nova_basename(env, args[1], name)) return nova_status(env, "failed");
  if (mkdirat(root_descriptor, name, 0700) != 0) {
    return nova_status(env, errno == EEXIST ? "exists" : "failed");
  }
  struct stat actual;
  if (fstatat(root_descriptor, name, &actual, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(actual.st_mode) || actual.st_uid != geteuid() ||
      (actual.st_mode & 0777) != 0700) {
    (void)unlinkat(root_descriptor, name, AT_REMOVEDIR);
    return nova_status(env, "failed");
  }
  return nova_identity_result(env, "ok", &actual);
}

static napi_value nova_mkdir_private_at(napi_env env, napi_callback_info info) {
  napi_value args[2];
  int root_descriptor;
  char name[256];
  struct stat root;
  if (!nova_args(env, info, 2, args) ||
      !nova_descriptor(env, args[0], &root_descriptor) ||
      fstat(root_descriptor, &root) != 0 || !S_ISDIR(root.st_mode) ||
      root.st_uid != geteuid() ||
      !nova_basename(env, args[1], name)) return nova_status(env, "failed");
  if (mkdirat(root_descriptor, name, 0700) != 0) {
    return nova_status(env, errno == EEXIST ? "exists" : "failed");
  }
  struct stat actual;
  if (fstatat(root_descriptor, name, &actual, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(actual.st_mode) || actual.st_uid != geteuid() ||
      (actual.st_mode & 0777) != 0700) {
    (void)unlinkat(root_descriptor, name, AT_REMOVEDIR);
    return nova_status(env, "failed");
  }
  return nova_identity_result(env, "ok", &actual);
}

static napi_value nova_rename_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  int root_descriptor;
  char from[256];
  char to[256];
  struct stat source;
  if (!nova_args(env, info, 3, args) ||
      !nova_descriptor(env, args[0], &root_descriptor) ||
      !nova_basename(env, args[1], from) ||
      !nova_basename(env, args[2], to) ||
      fstatat(root_descriptor, from, &source, AT_SYMLINK_NOFOLLOW) != 0 ||
      S_ISLNK(source.st_mode) ||
      renameat(root_descriptor, from, root_descriptor, to) != 0) return nova_status(env, "failed");
  return nova_status(env, "ok");
}

static napi_value nova_unlink_at(napi_env env, napi_callback_info info) {
  napi_value args[4];
  int root_descriptor;
  char name[256];
  uint64_t device;
  uint64_t inode;
  char kind[16];
  size_t kind_length = 0;
  struct stat actual;
  if (!nova_args(env, info, 4, args) ||
      !nova_descriptor(env, args[0], &root_descriptor) ||
      !nova_basename(env, args[1], name) ||
      !nova_expected_identity(env, args[2], &device, &inode) ||
      napi_get_value_string_utf8(env, args[3], kind, sizeof(kind), &kind_length) != napi_ok ||
      kind_length >= sizeof(kind)) return nova_status(env, "failed");
  if (fstatat(root_descriptor, name, &actual, AT_SYMLINK_NOFOLLOW) != 0) {
    return nova_status(env, errno == ENOENT ? "missing" : "failed");
  }
  if (S_ISLNK(actual.st_mode) || (uint64_t)actual.st_dev != device || (uint64_t)actual.st_ino != inode) {
    return nova_status(env, "mismatch");
  }
  int flags;
  if (strcmp(kind, "file") == 0 && S_ISREG(actual.st_mode)) flags = 0;
  else if (strcmp(kind, "directory") == 0 && S_ISDIR(actual.st_mode)) flags = AT_REMOVEDIR;
  else return nova_status(env, "mismatch");
  if (unlinkat(root_descriptor, name, flags) != 0) {
    return nova_status(env, errno == ENOENT ? "missing" : "failed");
  }
  return nova_status(env, "ok");
}

static int nova_export(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value function;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL, &function) == napi_ok &&
      napi_set_named_property(env, exports, name, function) == napi_ok;
}

NAPI_MODULE_INIT() {
  if (!nova_export(env, exports, "acquire", nova_acquire) ||
      !nova_export(env, exports, "probe", nova_probe) ||
      !nova_export(env, exports, "matchesAt", nova_matches_at) ||
      !nova_export(env, exports, "lookupAt", nova_lookup_at) ||
      !nova_export(env, exports, "createFileAt", nova_create_file_at) ||
      !nova_export(env, exports, "mkdirAt", nova_mkdir_at) ||
      !nova_export(env, exports, "mkdirPrivateAt", nova_mkdir_private_at) ||
      !nova_export(env, exports, "protectAt", nova_protect_at) ||
      !nova_export(env, exports, "renameAt", nova_rename_at) ||
      !nova_export(env, exports, "unlinkAt", nova_unlink_at)) return NULL;
  return exports;
}
