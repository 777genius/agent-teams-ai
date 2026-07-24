#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <linux/stat.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

enum { EXIT_REJECTED = 77, EXIT_UNSUPPORTED = 78, EXIT_USAGE = 64 };

static void fail_rejected(const char *code) {
  fprintf(stderr, "%s errno=%d\n", code, errno);
  exit(EXIT_REJECTED);
}

static uint64_t parse_u64(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') {
    fprintf(stderr, "invalid integer: %s\n", value);
    exit(EXIT_USAGE);
  }
  return (uint64_t)parsed;
}

static int guarded_openat2(int directory_fd, const char *path, int flags, mode_t mode,
                           uint64_t resolve) {
  struct open_how how = {
      .flags = (uint64_t)flags,
      .mode = (uint64_t)mode,
      .resolve = resolve,
  };
  int result = (int)syscall(SYS_openat2, directory_fd, path, &how, sizeof(how));
  if (result == -1 && (errno == ENOSYS || errno == EPERM)) {
    fprintf(stderr, "openat2_unsupported errno=%d\n", errno);
    exit(EXIT_UNSUPPORTED);
  }
  return result;
}

static struct statx statx_fd(int fd) {
  struct statx result;
  memset(&result, 0, sizeof(result));
  if (statx(fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT,
            STATX_TYPE | STATX_MODE | STATX_INO | STATX_MNT_ID, &result) == -1) {
    if (errno == ENOSYS || errno == EPERM) {
      fprintf(stderr, "statx_unsupported errno=%d\n", errno);
      exit(EXIT_UNSUPPORTED);
    }
    fail_rejected("root_statx_failed");
  }
  if ((result.stx_mask & (STATX_TYPE | STATX_INO | STATX_MNT_ID)) !=
      (STATX_TYPE | STATX_INO | STATX_MNT_ID)) {
    errno = ENOTSUP;
    fail_rejected("root_statx_incomplete");
  }
  return result;
}

static void verify_generation(int root_fd, const char *expected_generation) {
  int generation_fd = guarded_openat2(
      root_fd, ".atg-mount-generation", O_RDONLY | O_CLOEXEC | O_NOFOLLOW, 0,
      RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV);
  if (generation_fd == -1) {
    fail_rejected("generation_open_failed");
  }
  char buffer[129] = {0};
  ssize_t count = read(generation_fd, buffer, sizeof(buffer) - 1);
  (void)close(generation_fd);
  if (count < 0) {
    fail_rejected("generation_read_failed");
  }
  buffer[strcspn(buffer, "\r\n")] = '\0';
  if (strcmp(buffer, expected_generation) != 0) {
    errno = ESTALE;
    fail_rejected("stale_generation");
  }
}

static void sleep_ms(unsigned long milliseconds) {
  struct timespec delay = {
      .tv_sec = (time_t)(milliseconds / 1000),
      .tv_nsec = (long)((milliseconds % 1000) * 1000000UL),
  };
  while (nanosleep(&delay, &delay) == -1 && errno == EINTR) {
  }
}

static void split_relative_path(char *path, char **parent, char **base) {
  if (path[0] == '/' || strcmp(path, ".") == 0 || strcmp(path, "..") == 0) {
    errno = EINVAL;
    fail_rejected("invalid_relative_path");
  }
  char *slash = strrchr(path, '/');
  if (slash == NULL) {
    *parent = ".";
    *base = path;
    return;
  }
  *slash = '\0';
  *parent = path;
  *base = slash + 1;
  if ((*base)[0] == '\0' || strstr(path, "..") != NULL) {
    errno = EINVAL;
    fail_rejected("invalid_relative_path");
  }
}

static void create_file(int root_fd, const char *relative_path, const char *content) {
  char *path_copy = strdup(relative_path);
  if (path_copy == NULL) {
    fail_rejected("allocation_failed");
  }
  char *parent = NULL;
  char *base = NULL;
  split_relative_path(path_copy, &parent, &base);
  int parent_fd = guarded_openat2(
      root_fd, parent, O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0,
      RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV);
  if (parent_fd == -1) {
    free(path_copy);
    fail_rejected("parent_resolution_failed");
  }
  int output_fd = openat(parent_fd, base, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                         0600);
  if (output_fd == -1) {
    (void)close(parent_fd);
    free(path_copy);
    fail_rejected("create_failed");
  }
  size_t length = strlen(content);
  if (write(output_fd, content, length) != (ssize_t)length || fsync(output_fd) == -1 ||
      fsync(parent_fd) == -1) {
    fail_rejected("durable_create_failed");
  }
  (void)close(output_fd);
  (void)close(parent_fd);
  free(path_copy);
}

static int close_unintended_descriptors(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) {
    return 0;
  }
  if (errno != ENOSYS && errno != EPERM) {
    return -1;
  }
#endif
  int directory_fd = open("/proc/self/fd", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (directory_fd == -1) {
    return -1;
  }
  DIR *directory = fdopendir(directory_fd);
  if (directory == NULL) {
    (void)close(directory_fd);
    return -1;
  }
  int descriptors[4096];
  size_t count = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    char *end = NULL;
    long value = strtol(entry->d_name, &end, 10);
    if (end != entry->d_name && *end == '\0' && value >= 3 && value != directory_fd) {
      if (count >= sizeof(descriptors) / sizeof(descriptors[0])) {
        (void)closedir(directory);
        errno = EOVERFLOW;
        return -1;
      }
      descriptors[count++] = (int)value;
    }
  }
  (void)closedir(directory);
  for (size_t index = 0; index < count; index++) {
    (void)close(descriptors[index]);
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 8) {
    fprintf(stderr,
            "usage: %s ROOT EXPECTED_DEV EXPECTED_INO EXPECTED_MNT GENERATION OP ...\n",
            argv[0]);
    return EXIT_USAGE;
  }

  uint64_t expected_device = parse_u64(argv[2]);
  uint64_t expected_inode = parse_u64(argv[3]);
  uint64_t expected_mount_id = parse_u64(argv[4]);
  int root_fd = open(argv[1], O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (root_fd == -1) {
    fail_rejected("root_open_failed");
  }
  struct stat root_stat;
  if (fstat(root_fd, &root_stat) == -1 || !S_ISDIR(root_stat.st_mode)) {
    fail_rejected("root_fstat_failed");
  }
  struct statx root_statx = statx_fd(root_fd);
  if ((uint64_t)root_stat.st_dev != expected_device ||
      (uint64_t)root_stat.st_ino != expected_inode || root_statx.stx_ino != expected_inode ||
      (expected_mount_id != 0 && root_statx.stx_mnt_id != expected_mount_id)) {
    errno = ESTALE;
    fail_rejected("root_identity_drift");
  }
  verify_generation(root_fd, argv[5]);

  const char *pause_value = getenv("ATG_GUARD_PAUSE_MS");
  if (pause_value != NULL) {
    sleep_ms((unsigned long)parse_u64(pause_value));
  }

  if (strcmp(argv[6], "probe") == 0) {
    int probe_fd = guarded_openat2(
        root_fd, ".", O_PATH | O_DIRECTORY | O_CLOEXEC, 0,
        RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV);
    if (probe_fd == -1) {
      fail_rejected("openat2_probe_failed");
    }
    (void)close(probe_fd);
    printf("probe_ok dev=%llu ino=%llu mnt=%llu\n", (unsigned long long)expected_device,
           (unsigned long long)expected_inode, (unsigned long long)root_statx.stx_mnt_id);
    return 0;
  }
  if (strcmp(argv[6], "create") == 0 && argc == 9) {
    create_file(root_fd, argv[7], argv[8]);
    printf("create_ok generation=%s\n", argv[5]);
    return 0;
  }
  if (strcmp(argv[6], "exec") == 0 && argc >= 9) {
    int cwd_fd = guarded_openat2(
        root_fd, argv[7], O_PATH | O_DIRECTORY | O_CLOEXEC, 0,
        RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV);
    if (cwd_fd == -1 || fchdir(cwd_fd) == -1) {
      fail_rejected("cwd_entry_failed");
    }
    (void)close(cwd_fd);
    (void)close(root_fd);
    if (close_unintended_descriptors() == -1) {
      fail_rejected("descriptor_close_failed");
    }
    char **exec_argv = &argv[8];
    char *clean_environment[] = {
        "PATH=/usr/bin:/bin",
        "HOME=/nonexistent",
        "GIT_CONFIG_NOSYSTEM=1",
        "GIT_CONFIG_GLOBAL=/dev/null",
        "GIT_TERMINAL_PROMPT=0",
        NULL,
    };
    execve(exec_argv[0], exec_argv, clean_environment);
    fail_rejected("exec_failed");
  }
  fprintf(stderr, "unsupported operation\n");
  return EXIT_USAGE;
}
