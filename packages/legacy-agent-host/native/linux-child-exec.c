#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__) || !defined(SYS_close_range)
#error "linux-child-exec requires the qualified Linux x64 syscall ABI"
#endif

/* fd3 is the explicitly allocated status pipe, never a descriptor from a census.
 * There is no success record: EOF can also mean this helper died before exec. */
static _Noreturn void refuse(unsigned char stage, int error) {
  unsigned int value = error > 0 && error <= 4095 ? (unsigned int)error : (unsigned int)EIO;
  const unsigned char frame[12] = {
    'A', 'T', 'L', 'X', 1, stage, 0, 0,
    (unsigned char)value, (unsigned char)(value >> 8),
    (unsigned char)(value >> 16), (unsigned char)(value >> 24)
  };
  const ssize_t delivered = write(3, frame, sizeof(frame));
  _exit(delivered == (ssize_t)sizeof(frame) ? 111 : 112);
}

int main(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[1], "--linux-child-exec-v1") != 0 || argv[2][0] == '\0')
    refuse(1, EINVAL);
  int descriptor_flags = fcntl(3, F_GETFD);
  if (descriptor_flags < 0 || fcntl(3, F_SETFD, descriptor_flags | FD_CLOEXEC) < 0)
    refuse(1, errno);
  int status_flags = fcntl(3, F_GETFL);
  if (status_flags < 0 || fcntl(3, F_SETFL, status_flags | O_NONBLOCK) < 0)
    refuse(1, errno);
  if (syscall(SYS_close_range, 4U, UINT_MAX, 0U) != 0)
    refuse(2, errno);
  /* Node already installed the original cwd/env/uid/gid/stdio and group.
   * execvp retains its original PATH and ENOEXEC script semantics. No fork. */
  execvp(argv[2], &argv[3]);
  refuse(3, errno);
}
