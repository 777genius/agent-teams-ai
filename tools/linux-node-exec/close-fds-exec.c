#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

extern char **environ;

/* This process has not initialized Node/libuv and never creates a thread or child. */
static int close_from_proc(void) {
  DIR *directory = opendir("/proc/self/fd");
  if (directory == NULL) return -1;
  const int own_fd = dirfd(directory);
  if (own_fd < 0) {
    closedir(directory);
    return -1;
  }
  int failed = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == NULL) {
      if (errno != 0) failed = 1;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    char *end = NULL;
    errno = 0;
    const long value = strtol(entry->d_name, &end, 10);
    if (errno != 0 || end == entry->d_name || *end != '\0' || value < 0 || value > INT_MAX) {
      failed = 1;
      break;
    }
    const int fd = (int)value;
    if (fd <= STDERR_FILENO || fd == own_fd) continue;
    /* Linux releases the descriptor even on EINTR. Never retry a reused number. */
    if (close(fd) != 0 && errno != EINTR) {
      failed = 1;
      break;
    }
  }
  if (closedir(directory) != 0) failed = 1;
  return failed ? -1 : 0;
}

static int close_inherited(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, UINT_MAX, 0U) == 0) return 0;
  if (errno != ENOSYS) return -1;
#endif
  return close_from_proc();
}

static int fail(void) {
  static const char message[] = "Agent Teams: isolated Node launch failed\n";
  const ssize_t ignored = write(STDERR_FILENO, message, sizeof(message) - 1);
  (void)ignored;
  return 125;
}

int main(int argc, char **argv) {
  if (argc < 3 || strcmp(argv[1], "--") != 0 || argv[2][0] != '/') return fail();
  if (close_inherited() != 0) return fail();
  execve(argv[2], argv + 2, environ);
  return fail();
}
