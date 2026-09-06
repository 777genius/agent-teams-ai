#define _GNU_SOURCE
/* Benign descriptor consumer. No provider, namespace setup, product socket or activation authority. */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void insist(int ok) { if (!ok) _exit(91); }
static void write_all(int fd, const void *buffer, size_t n) {
  const unsigned char *p = buffer;
  while (n) {
    ssize_t count = write(fd, p, n);
    if (count < 0 && errno == EINTR) continue;
    insist(count > 0); p += count; n -= (size_t)count;
  }
}
static uint64_t now_ms(void) {
  struct timespec t; insist(clock_gettime(CLOCK_MONOTONIC, &t) == 0);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}
int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "normal";
  if (!strcmp(mode, "exit")) return 92;
  errno = 0; int reserved = fcntl(10, F_GETFD) == -1 && errno == EBADF;
  insist(reserved);
  for (int i = 12; i < 512; ++i) { errno = 0; insist(fcntl(i, F_GETFD) == -1 && errno == EBADF); }
  dprintf(8, "start %d %d %d\n", getpid(), getppid(), reserved);
  const int fds[] = {3, 4, 5, 6, 7, 8, 9, 11};
  for (size_t i = 0; i < sizeof fds / sizeof fds[0]; ++i) {
    struct stat st; int fd = fds[i]; insist(fstat(fd, &st) == 0);
    dprintf(8, "fd %d %llu %llu %u %d %d\n", fd, (unsigned long long)st.st_dev,
      (unsigned long long)st.st_ino, st.st_mode & 07777, fcntl(fd, F_GETFL), fcntl(fd, F_GET_SEALS));
  }
  errno = 0; insist(write(3, "x", 1) == -1 && errno == EBADF);
  int writable = open("/proc/self/fd/3", O_RDWR | O_CLOEXEC); insist(writable >= 0);
  errno = 0; insist(pwrite(writable, "x", 1, 0) == -1 && errno == EPERM); close(writable);
  insist(fcntl(3, F_GET_SEALS) == 15); dprintf(8, "seals 15 EBADF EPERM\n");
  write_all(9, "wal-descriptor-survived\n", 24);
  close(11); /* Model the required Owner anchor consumption before any helper creation. */
  if (!strcmp(mode, "close-bootstrap")) { close(4); for (;;) pause(); }
  if (!strcmp(mode, "no-read")) { for (;;) pause(); }
  unsigned char boot[65604], auth[8196], lease[65536];
  size_t used[2] = {0, 0}; int open_input[2] = {1, 1};
  unsigned char *buffers[2] = {boot, auth}; size_t limits[2] = {sizeof boot, sizeof auth};
  int input[2] = {4, 7}; uint64_t until = now_ms() + 7000;
  for (int i = 0; i < 2; ++i) insist(fcntl(input[i], F_SETFL, fcntl(input[i], F_GETFL) | O_NONBLOCK) == 0);
  while (open_input[0] || open_input[1]) {
    insist(now_ms() < until);
    struct pollfd p[2] = {{open_input[0] ? 4 : -1, POLLIN, 0}, {open_input[1] ? 7 : -1, POLLIN, 0}};
    int n = poll(p, 2, 50); insist(n >= 0 || errno == EINTR);
    for (int i = 0; i < 2; ++i) {
      if (!p[i].revents) continue;
      unsigned char piece[37]; ssize_t count = read(input[i], piece, sizeof piece);
      if (count < 0 && (errno == EAGAIN || errno == EINTR)) continue;
      insist(count >= 0 && used[i] + (size_t)count <= limits[i]);
      if (!count) { close(input[i]); open_input[i] = 0; }
      else { memcpy(buffers[i] + used[i], piece, (size_t)count); used[i] += (size_t)count; }
    }
  }
  struct stat st; insist(fstat(3, &st) == 0 && st.st_size > 0 && st.st_size <= (off_t)sizeof lease);
  insist(pread(3, lease, (size_t)st.st_size, 0) == st.st_size);
  dprintf(8, "frame %zu %zu %zu\n", used[0], used[1], (size_t)st.st_size);
  write_all(8, boot, used[0]); write_all(8, auth, used[1]); write_all(8, lease, (size_t)st.st_size);
  insist(fdatasync(8) == 0 && fdatasync(9) == 0);
  write_all(5, "READY", 5);
  for (;;) {
    struct pollfd p[2] = {{5, POLLIN, 0}, {6, POLLIN, 0}};
    int n = poll(p, 2, -1); if (n < 0 && errno == EINTR) continue; insist(n >= 0);
    if (p[1].revents) return 0; /* Any liveness traffic/loss ends this benign process. */
    if (p[0].revents) {
      char request[4]; ssize_t count = read(5, request, sizeof request);
      if (count <= 0) return 0;
      write_all(5, request, (size_t)count);
    }
  }
}
