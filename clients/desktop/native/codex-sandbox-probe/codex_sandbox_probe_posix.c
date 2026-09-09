#define _DARWIN_C_SOURCE 1
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif

static const char* NOVA_SIBLING_PREFIX = ".nova-audio-agent-codex-preflight-";
static const char* NOVA_MARKER_PREFIX = ".nova-audio-agent-codex-preflight-";

static int nova_starts_with(const char* value, const char* prefix) {
  return strncmp(value, prefix, strlen(prefix)) == 0;
}

static int nova_copy_parent(const char* path, char output[PATH_MAX]) {
  size_t length = strlen(path);
  if (length == 0 || length >= PATH_MAX) return 0;
  memcpy(output, path, length + 1);
  char* separator = strrchr(output, '/');
  if (separator == NULL || separator == output) return 0;
  *separator = '\0';
  return 1;
}

static const char* nova_basename(const char* path) {
  const char* separator = strrchr(path, '/');
  return separator == NULL ? path : separator + 1;
}

static int nova_regular_owned(const char* path) {
  struct stat link_info;
  struct stat file_info;
  return lstat(path, &link_info) == 0 && !S_ISLNK(link_info.st_mode) &&
      stat(path, &file_info) == 0 && S_ISREG(file_info.st_mode) &&
      file_info.st_uid == geteuid();
}

static int nova_validate_canary(const char* path, const char* workspace) {
  if (path == NULL || path[0] != '/' || strlen(path) >= PATH_MAX ||
      strcmp(nova_basename(path), "canary") != 0 || !nova_regular_owned(path)) return 0;
  char sibling[PATH_MAX];
  char common_parent[PATH_MAX];
  char workspace_parent[PATH_MAX];
  if (!nova_copy_parent(path, sibling) || !nova_starts_with(nova_basename(sibling), NOVA_SIBLING_PREFIX) ||
      !nova_copy_parent(sibling, common_parent) || !nova_copy_parent(workspace, workspace_parent)) return 0;
  return strcmp(common_parent, workspace_parent) == 0;
}

static int nova_validate_child_canary(const char* path) {
  if (path == NULL || path[0] != '/' || strlen(path) >= PATH_MAX ||
      strcmp(nova_basename(path), "canary") != 0 || !nova_regular_owned(path)) return 0;
  char sibling[PATH_MAX];
  return nova_copy_parent(path, sibling) && nova_starts_with(nova_basename(sibling), NOVA_SIBLING_PREFIX);
}

static int nova_validate_marker(const char* marker, const char* workspace) {
  if (marker == NULL || marker[0] != '/' || strlen(marker) >= PATH_MAX) return 0;
  char parent[PATH_MAX];
  if (!nova_copy_parent(marker, parent) || strcmp(parent, workspace) != 0) return 0;
  const char* name = nova_basename(marker);
  size_t prefix_length = strlen(NOVA_MARKER_PREFIX);
  if (!nova_starts_with(name, NOVA_MARKER_PREFIX) || strlen(name) != prefix_length + 32) return 0;
  for (size_t index = prefix_length; index < prefix_length + 32; index += 1) {
    if (!((name[index] >= '0' && name[index] <= '9') || (name[index] >= 'a' && name[index] <= 'f'))) return 0;
  }
  struct stat info;
  return lstat(marker, &info) != 0 && errno == ENOENT;
}

static int nova_write_exact(int descriptor, const char* value) {
  size_t total = strlen(value);
  size_t offset = 0;
  while (offset < total) {
    ssize_t written = write(descriptor, value + offset, total - offset);
    if (written <= 0) return 0;
    offset += (size_t)written;
  }
  return 1;
}

static int nova_attempt_write(const char* path, const char* value, int exclusive) {
  int flags = O_WRONLY | O_NOFOLLOW | O_CLOEXEC;
  if (exclusive) flags |= O_CREAT | O_EXCL;
  else flags |= O_TRUNC;
  int descriptor = open(path, flags, 0600);
  if (descriptor < 0) return 0;
  int succeeded = nova_write_exact(descriptor, value);
  if (close(descriptor) != 0) succeeded = 0;
  return succeeded;
}

static int nova_self_path(char output[PATH_MAX]) {
#ifdef __APPLE__
  uint32_t size = PATH_MAX;
  char unresolved[PATH_MAX];
  if (_NSGetExecutablePath(unresolved, &size) != 0 || realpath(unresolved, output) == NULL) return 0;
#else
  ssize_t size = readlink("/proc/self/exe", output, PATH_MAX - 1);
  if (size <= 0 || size >= PATH_MAX - 1) return 0;
  output[size] = '\0';
#endif
  return 1;
}

static double nova_monotonic_seconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1.0;
  return (double)now.tv_sec + ((double)now.tv_nsec / 1000000000.0);
}

static int nova_child_denied(const char* canary) {
  char executable[PATH_MAX];
  if (!nova_self_path(executable)) return 0;
  char* const arguments[] = {executable, "--child", (char*)canary, NULL};
  char* const environment[] = {NULL};
  pid_t child = 0;
  if (posix_spawn(&child, executable, NULL, NULL, arguments, environment) != 0) return 0;
  double deadline = nova_monotonic_seconds() + 2.0;
  int status = 0;
  while (nova_monotonic_seconds() >= 0.0 && nova_monotonic_seconds() < deadline) {
    pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child) return WIFEXITED(status) && WEXITSTATUS(status) == 0;
    if (result < 0) return 0;
    struct timespec pause = {.tv_sec = 0, .tv_nsec = 10000000};
    (void)nanosleep(&pause, NULL);
  }
  (void)kill(child, SIGKILL);
  (void)waitpid(child, &status, 0);
  return 0;
}

static int nova_network_denied(uint16_t port) {
  int descriptor = socket(AF_INET, SOCK_STREAM, 0);
  if (descriptor < 0) return 1;
  int flags = fcntl(descriptor, F_GETFL, 0);
  if (flags < 0 || fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) != 0) {
    (void)close(descriptor);
    return 1;
  }
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int connected = connect(descriptor, (struct sockaddr*)&address, sizeof(address)) == 0;
  if (!connected && errno == EINPROGRESS) {
    struct pollfd candidate = {.fd = descriptor, .events = POLLOUT, .revents = 0};
    if (poll(&candidate, 1, 1000) > 0) {
      int socket_error = 0;
      socklen_t length = sizeof(socket_error);
      connected = getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &socket_error, &length) == 0 && socket_error == 0;
    }
  }
  (void)close(descriptor);
  return !connected;
}

static const char* nova_limit_class(int resource) {
  struct rlimit limit;
  if (getrlimit(resource, &limit) != 0) return "unavailable";
  return limit.rlim_cur == RLIM_INFINITY ? "unbounded" : "finite";
}

static int nova_child_main(const char* canary) {
  if (!nova_validate_child_canary(canary)) return 2;
  return nova_attempt_write(canary, "child-write-succeeded", 0) ? 9 : 0;
}

static int nova_main(int argc, char** argv) {
  if (argc == 3 && strcmp(argv[1], "--child") == 0) return nova_child_main(argv[2]);
  if (argc != 6 || strcmp(argv[1], "--main") != 0) return 2;

  char workspace[PATH_MAX];
  char canary[PATH_MAX];
  if (argv[2][0] != '/' || realpath(argv[2], workspace) == NULL || strcmp(workspace, argv[2]) != 0 ||
      realpath(argv[3], canary) == NULL || strcmp(canary, argv[3]) != 0 ||
      !nova_validate_canary(canary, workspace) || !nova_validate_marker(argv[4], workspace)) return 2;
  char* end = NULL;
  errno = 0;
  long port_number = strtol(argv[5], &end, 10);
  if (errno != 0 || end == argv[5] || *end != '\0' || port_number < 1 || port_number > 65535) return 2;

  char current[PATH_MAX];
  char resolved_current[PATH_MAX];
  int cwd_matches = getcwd(current, sizeof(current)) != NULL &&
      realpath(current, resolved_current) != NULL && strcmp(resolved_current, workspace) == 0;
  int inside_write = nova_attempt_write(argv[4], "nova-audio-agent-preflight", 1);
  int inside_remove = unlink(argv[4]) == 0;
  int outside_write_denied = !nova_attempt_write(canary, "outside-write-succeeded", 0);
  int child_outside_write_denied = nova_child_denied(canary);
  int network_denied = nova_network_denied((uint16_t)port_number);

  int written = printf(
      "{\"cwd_matches\":%s,\"inside_write\":%s,\"inside_remove\":%s,"
      "\"outside_write_denied\":%s,\"child_outside_write_denied\":%s,"
      "\"network_denied\":%s,\"limits\":{\"cpu\":\"%s\",\"as\":\"%s\",\"nofile\":\"%s\"}}\n",
      cwd_matches ? "true" : "false",
      inside_write ? "true" : "false",
      inside_remove ? "true" : "false",
      outside_write_denied ? "true" : "false",
      child_outside_write_denied ? "true" : "false",
      network_denied ? "true" : "false",
      nova_limit_class(RLIMIT_CPU),
      nova_limit_class(RLIMIT_AS),
      nova_limit_class(RLIMIT_NOFILE));
  return written > 0 && fflush(stdout) == 0 ? 0 : 2;
}

int main(int argc, char** argv) {
  return nova_main(argc, argv);
}
