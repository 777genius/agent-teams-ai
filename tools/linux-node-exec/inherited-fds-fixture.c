#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int fail(void) { return 124; }

int main(int argc, char **argv) {
  if (argc < 5 || argv[2][0] != '/') return fail();
  int error = 0;
  if (strcmp(argv[1], "fallback") == 0) error = ENOSYS;
  else if (strcmp(argv[1], "refuse") == 0) error = EPERM;
  else if (strcmp(argv[1], "normal") != 0) return fail();
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) != 0 || limit.rlim_max <= 4096) return fail();
  if (limit.rlim_cur <= 4096) {
    limit.rlim_cur = 4097;
    if (setrlimit(RLIMIT_NOFILE, &limit) != 0) return fail();
  }
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return fail();
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = 0 };
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(fd, 1) != 0)
    return fail();
  if (dup2(fd, 52) != 52 || dup2(fd, 4096) != 4096) return fail();
  if (fd != 52 && fd != 4096 && close(fd) != 0) return fail();
  struct stat descriptor;
  if (fstat(52, &descriptor) != 0 || !S_ISSOCK(descriptor.st_mode)) return fail();
  if (error != 0) {
    struct sock_filter instructions[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_close_range, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (unsigned int)error),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog filter = {
      .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])),
      .filter = instructions,
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &filter) != 0)
      return fail();
  }
  if (printf("TEST_DRIVER %ld %ld %llu\n", (long)getpid(), (long)getpgrp(),
             (unsigned long long)descriptor.st_ino) < 0 || fflush(stdout) != 0)
    return fail();
  execv(argv[2], argv + 2);
  return fail();
}
