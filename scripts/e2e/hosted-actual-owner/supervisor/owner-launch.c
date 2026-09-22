#define _GNU_SOURCE
/* Linux, C17, single threaded. Only this process forks; the TS runtime never does.
 * AOL1 is private syscall framing, NOT a replacement for Owner bootstrap-v2.
 * See README.md for byte layout, ownership and the ptrace exec barrier. */
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAGIC 0x414f4c31u
#define SEALS (F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE)
#define MAX_INIT 32768u
#define MAX_BOOT 65604u
/* Transport ceiling only. The selected TS producer and Owner decoder enforce
 * explicit v1/v2 document limits, with no probing or downgrade. */
#define MAX_AUTH (1024u * 1024u + 4u)
#define MAX_LEASE 65536u
#define ROLES 8
enum { INIT = 1, ASSEMBLED, EXEC_ACK, CANCEL };
enum { HELD = 101, SEALED, EXEC_STOPPED, DELIVERED, EXITED, FAILED = 199 };
static const int targets[ROLES] = {3, 4, 5, 6, 7, 8, 9, 11};
static int phase = 1, child = -1, pidfd = -1, reaped, child_status;
static int lease_rw = -1, writers[2] = {-1, -1};
static uint64_t deadline, child_ticks;
static size_t sent[2];
static unsigned char *frames, *init_bytes;
static uint32_t frames_size, init_size;

struct descriptor { int fd, target, flags, seals; struct stat st; uint64_t closed_ns; };
static struct descriptor roles[ROLES];
static uint32_t get32(const unsigned char *p) {
  return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}
static void put32(unsigned char **p, uint32_t n) {
  *(*p)++ = n >> 24; *(*p)++ = n >> 16; *(*p)++ = n >> 8; *(*p)++ = n;
}
static void put64(unsigned char **p, uint64_t n) {
  put32(p, (uint32_t)(n >> 32)); put32(p, (uint32_t)n);
}
static uint64_t now_ns(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(120);
  return (uint64_t)t.tv_sec * 1000000000u + (uint64_t)t.tv_nsec;
}
static void wipe(void *p, size_t n) {
  volatile unsigned char *v = p;
  while (n--) *v++ = 0;
}
static void close_owned(int *fd) {
  if (*fd >= 0) { int n = *fd; *fd = -1; close(n); }
}
static int remaining(uint64_t until) {
  uint64_t n = now_ns();
  if (n >= until) { errno = ETIMEDOUT; return -1; }
  return (int)((until - n + 999999u) / 1000000u);
}
static int nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
static int io_all(int fd, void *bytes, size_t len, int writing, uint64_t until) {
  unsigned char *p = bytes;
  while (len) {
    if (remaining(until) < 0) return -1;
    ssize_t n = writing ? write(fd, p, len) : read(fd, p, len);
    if (n > 0) { p += n; len -= (size_t)n; continue; }
    if (!n) { errno = EPIPE; return -1; }
    if (errno == EINTR) continue;
    if (errno != EAGAIN && errno != EWOULDBLOCK) return -1;
    struct pollfd pollfd = {fd, writing ? POLLOUT : POLLIN, 0};
    int ms = remaining(until);
    if (ms < 0 || poll(&pollfd, 1, ms) < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
  }
  return 0;
}
static int emit(uint32_t type, const unsigned char *body, size_t len, uint64_t until) {
  unsigned char h[12], *p = h;
  put32(&p, MAGIC); put32(&p, type); put32(&p, (uint32_t)len);
  return io_all(1, h, sizeof h, 1, until) || io_all(1, (void *)body, len, 1, until);
}
static void reap_owned(void) {
  if (child <= 0 || reaped) return;
  int n = waitpid(child, &child_status, WNOHANG);
  if (n == child && (WIFEXITED(child_status) || WIFSIGNALED(child_status))) reaped = 1;
}
static void cleanup(void) {
  /* pidfd was acquired from our unreaped fork result, never an input PID. */
  if (child > 0 && !reaped) {
    if (pidfd >= 0) syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0);
    else kill(child, SIGKILL); /* only the still-unreaped direct child, if pidfd_open failed */
  }
  close_owned(&lease_rw); close_owned(&writers[0]); close_owned(&writers[1]);
  uint64_t until = now_ns() + 2000000000u;
  while (child > 0 && !reaped && now_ns() < until) {
    reap_owned();
    if (!reaped) {
      /* A trace stop after SIGKILL may need resuming to complete termination. */
      ptrace(PTRACE_CONT, child, NULL, (void *)(intptr_t)SIGKILL);
      struct pollfd p = {pidfd, POLLIN, 0}; poll(&p, pidfd >= 0 ? 1 : 0, 10);
    }
  }
  close_owned(&pidfd);
}
static _Noreturn void fail(int error) {
  int failed_phase = phase;
  cleanup();
  unsigned char body[40], *p = body;
  put32(&p, failed_phase); put32(&p, error); put32(&p, child > 0 ? (uint32_t)child : 0);
  put32(&p, reaped); put32(&p, (uint32_t)child_status); put64(&p, now_ns());
  put32(&p, (uint32_t)sent[0]); put32(&p, (uint32_t)sent[1]);
  emit(FAILED, body, (size_t)(p - body), now_ns() + 250000000u);
  if (frames) wipe(frames, frames_size);
  if (init_bytes) wipe(init_bytes, init_size);
  _exit(1);
}
#define CHECK(x) do { if (!(x)) fail(errno ? errno : EINVAL); } while (0)
static unsigned char *message(uint32_t expected, uint32_t maximum, uint32_t *length) {
  unsigned char h[12];
  CHECK(io_all(0, h, sizeof h, 0, deadline) == 0);
  CHECK(get32(h) == MAGIC);
  uint32_t type = get32(h + 4), len = get32(h + 8);
  if (type == CANCEL && len == 0) fail(ECANCELED);
  CHECK(type == expected && len <= maximum);
  unsigned char *b = calloc((size_t)len + 1, 1);
  CHECK(b != NULL);
  *length = len;
  /* Register buffers before an I/O failure so cleanup erases partial secrets. */
  if (expected == ASSEMBLED) { frames = b; frames_size = len; }
  if (expected == INIT) { init_bytes = b; init_size = len; }
  CHECK(io_all(0, b, len, 0, deadline) == 0);
  return b;
}
static uint64_t ticks(pid_t pid) {
  char path[64], text[4096];
  snprintf(path, sizeof path, "/proc/%d/stat", pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  CHECK(fd >= 0);
  ssize_t n = read(fd, text, sizeof text - 1); close(fd);
  CHECK(n > 0 && n < (ssize_t)sizeof text - 1);
  text[n] = 0;
  CHECK(strtol(text, NULL, 10) == pid);
  char *p = strrchr(text, ')'); CHECK(p && p[1] == ' '); p += 2;
  /* Field 3 (state) is first after comm; field 22 is starttime. */
  for (int i = 0; i < 19; ++i) { p = strchr(p, ' '); CHECK(p); ++p; }
  char *end; errno = 0;
  unsigned long long t = strtoull(p, &end, 10);
  CHECK(!errno && end > p && *end == ' ' && t > 0 && t <= 9007199254740991ull);
  return t;
}
static uint64_t ns_inode(pid_t pid, const char *kind) {
  char path[64]; struct stat st;
  snprintf(path, sizeof path, "/proc/%d/ns/%s", pid, kind);
  CHECK(stat(path, &st) == 0); return st.st_ino;
}
static int same(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode &&
    a->st_uid == b->st_uid && a->st_gid == b->st_gid && a->st_size == b->st_size &&
    a->st_nlink == b->st_nlink && a->st_mtim.tv_sec == b->st_mtim.tv_sec &&
    a->st_mtim.tv_nsec == b->st_mtim.tv_nsec && a->st_ctim.tv_sec == b->st_ctim.tv_sec &&
    a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static struct descriptor inspect(int fd, int target) {
  struct descriptor d = {.fd = fd, .target = target, .closed_ns = 0};
  CHECK(fstat(fd, &d.st) == 0);
  char path[64]; struct stat linked;
  snprintf(path, sizeof path, "/proc/self/fd/%d", fd);
  CHECK(stat(path, &linked) == 0 && same(&d.st, &linked));
  d.flags = fcntl(fd, F_GETFL); CHECK(d.flags >= 0);
  d.seals = fcntl(fd, F_GET_SEALS);
  CHECK(d.seals >= 0 || errno == EINVAL);
  return d;
}
static void row(unsigned char **p, const struct descriptor *d) {
  put32(p, d->fd); put32(p, d->target);
  put32(p, S_ISREG(d->st.st_mode) ? 1 : S_ISSOCK(d->st.st_mode) ? 2 : 0);
  put32(p, d->flags & O_ACCMODE); put32(p, !!(d->flags & O_APPEND));
  put32(p, d->st.st_mode & 07777); put32(p, d->st.st_uid); put32(p, d->st.st_gid);
  put32(p, (uint32_t)d->seals);
  put64(p, d->st.st_dev); put64(p, d->st.st_ino); put64(p, d->st.st_size); put64(p, d->st.st_nlink);
  put64(p, (uint64_t)d->st.st_mtim.tv_sec * 1000000000u + d->st.st_mtim.tv_nsec);
  put64(p, (uint64_t)d->st.st_ctim.tv_sec * 1000000000u + d->st.st_ctim.tv_nsec);
  put64(p, d->closed_ns);
}
static void connected_stream(int fd) {
  int type; socklen_t size = sizeof type; struct sockaddr_storage peer;
  CHECK(getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) == 0 && type == SOCK_STREAM);
  size = sizeof peer;
  CHECK(getpeername(fd, (struct sockaddr *)&peer, &size) == 0 && peer.ss_family == AF_UNIX);
}
static void close_observed(int fd, uint64_t *observed) {
  struct stat st;
  CHECK(close(fd) == 0);
  /* No descriptor allocation between close and fstat; never recheck this number later. */
  errno = 0; CHECK(fstat(fd, &st) == -1 && errno == EBADF); *observed = now_ns();
}
static void remove_unlisted(const int *keep, size_t count) {
  DIR *dir = opendir("/proc/self/fd"); CHECK(dir);
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    char *end; long n = strtol(entry->d_name, &end, 10);
    if (*end || n <= 2 || n == dirfd(dir)) continue;
    int allowed = 0;
    for (size_t i = 0; i < count; ++i) if (n == keep[i]) allowed = 1;
    if (!allowed) close((int)n);
  }
  closedir(dir);
}
static void socket_input(int *child_end, int *writer) {
  int pair[2], small = 4096;
  CHECK(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) == 0);
  *child_end = pair[0]; *writer = pair[1];
  CHECK(shutdown(*child_end, SHUT_WR) == 0 && shutdown(*writer, SHUT_RD) == 0);
  CHECK(nonblock(*writer) == 0);
  CHECK(setsockopt(*writer, SOL_SOCKET, SO_SNDBUF, &small, sizeof small) == 0);
}
static void child_exec(pid_t parent, int cwd, char **args, char **env) {
  /* All operations occur in this standalone single-threaded C image. */
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) _exit(121);
  int copies[ROLES];
  for (int i = 0; i < ROLES; ++i) {
    copies[i] = fcntl(roles[i].fd, F_DUPFD_CLOEXEC, 256);
    if (copies[i] < 0) _exit(122);
  }
  if (fchdir(cwd) || dup2(2, 0) < 0 || dup2(2, 1) < 0) _exit(122);
  for (int i = 0; i < ROLES; ++i) {
    if (dup3(copies[i], targets[i], 0) < 0) _exit(122);
    struct stat st;
    if (fstat(targets[i], &st) || !same(&st, &roles[i].st) ||
        fcntl(targets[i], F_GETFL) != roles[i].flags) _exit(122);
  }
  close(10); /* Reserved only at inheritance; Owner's runtime may later allocate it. */
  if (syscall(SYS_close_range, 12u, UINT_MAX, 0) ||
      ptrace(PTRACE_TRACEME, 0, NULL, NULL) || raise(SIGSTOP)) _exit(123);
  /* This independent gate makes it impossible to exec with an unsealed/writable FD3. */
  struct stat lease, executable;
  if (fstat(3, &lease) || lease.st_size < 1 || lease.st_size > MAX_LEASE ||
      (fcntl(3, F_GETFL) & O_ACCMODE) != O_RDONLY ||
      fcntl(3, F_GET_SEALS) != SEALS || fstat(11, &executable) ||
      !same(&executable, &roles[7].st)) _exit(124);
  syscall(SYS_execveat, 11, "", args, env, AT_EMPTY_PATH);
  _exit(125); /* Never exec a path or try another image. FD11 is inherited intact. */
}
static void wait_stop(int exec_event) {
  for (;;) {
    CHECK(remaining(deadline) >= 0);
    int status, result = waitpid(child, &status, WNOHANG | WUNTRACED);
    CHECK(result >= 0);
    if (result == child) {
      child_status = status;
      if (WIFEXITED(status) || WIFSIGNALED(status)) { reaped = 1; fail(ECHILD); }
      if (!WIFSTOPPED(status) || (exec_event ?
          (WSTOPSIG(status) != SIGTRAP || (status >> 16) != PTRACE_EVENT_EXEC) :
          WSTOPSIG(status) != SIGSTOP)) fail(EPROTO);
      return;
    }
    struct pollfd p = {0, POLLIN, 0};
    CHECK(poll(&p, 1, 5) >= 0 || errno == EINTR);
    if (p.revents) fail(ECANCELED); /* Cancel, EOF, or premature command: no release. */
  }
}
static void inspect_child_map(void) {
  /* Independent parent inspection while the remapped child is actually stopped. */
  char path[80], info[4096]; struct stat st;
  for (int i = 0; i < ROLES; ++i) {
    snprintf(path, sizeof path, "/proc/%d/fd/%d", child, targets[i]);
    CHECK(stat(path, &st) == 0 && same(&st, &roles[i].st));
    snprintf(path, sizeof path, "/proc/%d/fdinfo/%d", child, targets[i]);
    int fd = open(path, O_RDONLY | O_CLOEXEC); CHECK(fd >= 0);
    ssize_t n = read(fd, info, sizeof info - 1); close(fd);
    CHECK(n > 0 && n < (ssize_t)sizeof info - 1); info[n] = 0;
    char *flags = strstr(info, "flags:\t"); CHECK(flags);
    char *end; unsigned long f = strtoul(flags + 7, &end, 8);
    CHECK(*end == '\n' && !(f & O_CLOEXEC) && f == (unsigned int)roles[i].flags);
  }
  snprintf(path, sizeof path, "/proc/%d/fd", child);
  DIR *dir = opendir(path); CHECK(dir); struct dirent *entry;
  while ((entry = readdir(dir))) {
    char *end; long fd = strtol(entry->d_name, &end, 10);
    if (*end) continue;
    CHECK((fd >= 0 && fd <= 9) || fd == 11);
  }
  closedir(dir);
}
static char **strings(unsigned char **cursor, unsigned char *end) {
  CHECK(end - *cursor >= 4);
  uint32_t count = get32(*cursor); *cursor += 4; CHECK(count <= 32);
  char **values = calloc(count + 1, sizeof(char *)); CHECK(values);
  for (uint32_t i = 0; i < count; ++i) {
    CHECK(end - *cursor >= 4);
    uint32_t n = get32(*cursor); *cursor += 4;
    CHECK(n >= 1 && n <= 8192 && end - *cursor >= n && !memchr(*cursor, 0, n));
    values[i] = strndup((char *)*cursor, n); CHECK(values[i]); *cursor += n;
  }
  return values;
}
static void deliver(const unsigned char *bootstrap, size_t boot_len,
                    const unsigned char *auth, size_t auth_len) {
  const unsigned char *data[2] = {bootstrap, auth}; size_t sizes[2] = {boot_len, auth_len};
  while (writers[0] >= 0 || writers[1] >= 0) {
    int ms = remaining(deadline); CHECK(ms >= 0);
    struct pollfd p[4] = {{0, POLLIN, 0}, {pidfd, POLLIN, 0},
      {writers[0], POLLOUT, 0}, {writers[1], POLLOUT, 0}};
    int r = poll(p, 4, ms);
    if (r < 0 && errno == EINTR) continue;
    CHECK(r >= 0);
    if (p[0].revents) fail(ECANCELED);
    if (p[1].revents) { reap_owned(); fail(ECHILD); }
    for (int i = 0; i < 2; ++i) {
      if (writers[i] < 0 || !p[i + 2].revents) continue;
      ssize_t n = send(writers[i], data[i] + sent[i], sizes[i] - sent[i], MSG_NOSIGNAL);
      if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
      CHECK(n > 0); sent[i] += (size_t)n;
      if (sent[i] == sizes[i]) {
        CHECK(shutdown(writers[i], SHUT_WR) == 0); close_owned(&writers[i]);
      }
    }
  }
}
int main(int argc, char **argv) {
  (void)argv;
  deadline = now_ns() + 5000000000u;
  CHECK(argc == 1);
  signal(SIGPIPE, SIG_IGN); umask(077);
  pid_t caller = getppid();
  CHECK(prctl(PR_SET_PDEATHSIG, SIGKILL) == 0 && getppid() == caller);
  CHECK(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0);
  CHECK(nonblock(0) == 0 && nonblock(1) == 0);
  unsigned char *init = message(INIT, MAX_INIT, &init_size), *cursor = init;
  CHECK(init_size >= 32);
  int inputs[6]; /* activation, liveness, raw, WAL, image, cwd (arbitrary distinct slots) */
  for (int i = 0; i < 6; ++i) {
    uint32_t n = get32(cursor); cursor += 4; CHECK(n >= 3 && n <= 254); inputs[i] = (int)n;
    for (int j = 0; j < i; ++j) CHECK(inputs[j] != inputs[i]);
  }
  char **args = strings(&cursor, init + init_size), **env = strings(&cursor, init + init_size);
  CHECK(cursor == init + init_size && args[0]);
  remove_unlisted(inputs, 6);
  phase = 2;
  struct stat cwd; CHECK(fstat(inputs[5], &cwd) == 0 && S_ISDIR(cwd.st_mode));
  lease_rw = memfd_create("hosted-owner-lease-v2", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  CHECK(lease_rw >= 0 && fchmod(lease_rw, 0600) == 0);
  char path[64]; snprintf(path, sizeof path, "/proc/self/fd/%d", lease_rw);
  /* A new read-only open description of this memfd, NOT dup(writable_fd). */
  int lease_ro = open(path, O_RDONLY | O_CLOEXEC); CHECK(lease_ro >= 0);
  struct stat rw, ro; CHECK(fstat(lease_rw, &rw) == 0 && fstat(lease_ro, &ro) == 0 && same(&rw, &ro));
  int boot_child, auth_child;
  socket_input(&boot_child, &writers[0]); socket_input(&auth_child, &writers[1]);
  int source[ROLES] = {lease_ro, boot_child, inputs[0], inputs[1], auth_child, inputs[2], inputs[3], inputs[4]};
  uint64_t before = now_ns();
  for (int i = 0; i < ROLES; ++i) {
    roles[i] = inspect(source[i], targets[i]); struct descriptor *d = &roles[i];
    CHECK(d->st.st_uid == getuid() && d->st.st_gid == getgid());
    for (int j = 0; j < i; ++j) CHECK(d->fd != roles[j].fd &&
      !(d->st.st_dev == roles[j].st.st_dev && d->st.st_ino == roles[j].st.st_ino));
    if (i >= 1 && i <= 4) { CHECK(S_ISSOCK(d->st.st_mode)); connected_stream(d->fd); }
    if (i == 0) CHECK(S_ISREG(d->st.st_mode) && d->st.st_size == 0 && d->seals == 0 &&
      (d->flags & O_ACCMODE) == O_RDONLY && (d->st.st_mode & 07777) == 0600);
    if (i == 5 || i == 6) CHECK(S_ISREG(d->st.st_mode) && d->st.st_nlink == 1 &&
      (d->st.st_mode & 07777) == 0600 && (d->flags & O_ACCMODE) == O_WRONLY &&
      (d->flags & O_APPEND) && d->st.st_size >= 0 && d->st.st_size <= 64 * 1024 * 1024 &&
      (i != 6 || d->st.st_size == 0));
    if (i == 7) CHECK(S_ISREG(d->st.st_mode) && d->st.st_nlink == 1 &&
      (d->st.st_mode & 07777) == 0500 && (d->flags & O_ACCMODE) == O_RDONLY &&
      d->st.st_size > 0 && d->st.st_size <= 1024 * 1024 * 1024);
  }
  unsigned char elf[4]; CHECK(pread(inputs[4], elf, 4, 0) == 4 && !memcmp(elf, "\177ELF", 4));
  unsigned char nonce[32]; CHECK(getrandom(nonce, sizeof nonce, GRND_NONBLOCK) == (ssize_t)sizeof nonce);
  pid_t parent = getpid(); uint64_t parent_ticks = ticks(parent), caller_ticks = ticks(caller);
  phase = 3;
  uint64_t fork_ns = now_ns(); child = fork(); CHECK(child >= 0);
  if (!child) child_exec(parent, inputs[5], args, env);
  /* Close every handed-off copy before any allocation can reuse its number. */
  for (int i = 0; i < ROLES; ++i) close_observed(roles[i].fd, &roles[i].closed_ns);
  uint64_t cwd_closed; close_observed(inputs[5], &cwd_closed);
  pidfd = (int)syscall(SYS_pidfd_open, child, 0); CHECK(pidfd >= 0);
  wait_stop(0);
  inspect_child_map();
  CHECK(ptrace(PTRACE_SETOPTIONS, child, NULL, (void *)(uintptr_t)(PTRACE_O_TRACEEXEC | PTRACE_O_EXITKILL)) == 0);
  child_ticks = ticks(child); CHECK(child != parent && parent != caller);
  struct stat pidfd_stat; CHECK(fstat(pidfd, &pidfd_stat) == 0);
  unsigned char out[2048], *p = out;
  put32(&p, parent); put32(&p, caller); put32(&p, child);
  put64(&p, parent_ticks); put64(&p, caller_ticks); put64(&p, child_ticks);
  put64(&p, pidfd_stat.st_dev); put64(&p, pidfd_stat.st_ino);
  put64(&p, ns_inode(parent, "pid")); put64(&p, ns_inode(parent, "net"));
  put64(&p, ns_inode(child, "pid")); put64(&p, ns_inode(child, "net"));
  memcpy(p, nonce, 32); p += 32;
  put64(&p, before); put64(&p, fork_ns); put64(&p, now_ns()); put32(&p, ROLES);
  for (int i = 0; i < ROLES; ++i) row(&p, &roles[i]);
  phase = 4; CHECK(emit(HELD, out, (size_t)(p - out), deadline) == 0);
  phase = 5;
  message(ASSEMBLED, 12 + MAX_LEASE + MAX_BOOT + MAX_AUTH, &frames_size);
  CHECK(frames_size >= 12);
  uint32_t lease_len = get32(frames), boot_len = get32(frames + 4), auth_len = get32(frames + 8);
  CHECK(lease_len >= 1 && lease_len <= MAX_LEASE && boot_len >= 70 && boot_len <= MAX_BOOT &&
    auth_len >= 6 && auth_len <= MAX_AUTH && frames_size == 12 + lease_len + boot_len + auth_len);
  unsigned char *lease = frames + 12, *boot = lease + lease_len, *auth = boot + boot_len;
  CHECK(get32(boot) == boot_len - 68 && get32(auth) == auth_len - 4);
  phase = 6;
  size_t written = 0;
  while (written < lease_len) {
    CHECK(remaining(deadline) >= 0);
    ssize_t n = pwrite(lease_rw, lease + written, lease_len - written, (off_t)written);
    if (n < 0 && errno == EINTR) continue;
    CHECK(n > 0); written += (size_t)n;
  }
  CHECK(fcntl(lease_rw, F_ADD_SEALS, SEALS) == 0 && fcntl(lease_rw, F_GET_SEALS) == SEALS);
  struct descriptor sealed = inspect(lease_rw, 3); CHECK(sealed.st.st_size == lease_len);
  uint64_t construction_closed; close_observed(lease_rw, &construction_closed); lease_rw = -1;
  p = out; put64(&p, now_ns()); row(&p, &sealed); put64(&p, construction_closed);
  CHECK(emit(SEALED, out, (size_t)(p - out), deadline) == 0);
  phase = 7; CHECK(ptrace(PTRACE_CONT, child, NULL, NULL) == 0); wait_stop(1);
  CHECK(ticks(child) == child_ticks);
  snprintf(path, sizeof path, "/proc/%d/exe", child);
  int executed_fd = open(path, O_RDONLY | O_CLOEXEC); CHECK(executed_fd >= 0);
  struct descriptor executed = inspect(executed_fd, 11); CHECK(same(&executed.st, &roles[7].st));
  p = out; put32(&p, child); put64(&p, child_ticks); put64(&p, now_ns()); row(&p, &executed);
  close(executed_fd);
  CHECK(emit(EXEC_STOPPED, out, (size_t)(p - out), deadline) == 0);
  phase = 8;
  uint32_t ack_size; unsigned char *ack = message(EXEC_ACK, 0, &ack_size); free(ack);
  CHECK(ticks(child) == child_ticks && remaining(deadline) >= 0);
  CHECK(ptrace(PTRACE_DETACH, child, NULL, NULL) == 0);
  phase = 9; deliver(boot, boot_len, auth, auth_len);
  wipe(frames, frames_size); free(frames); frames = NULL;
  p = out; put64(&p, now_ns()); put32(&p, (uint32_t)sent[0]); put32(&p, (uint32_t)sent[1]);
  reap_owned(); if (reaped) fail(ECHILD);
  CHECK(emit(DELIVERED, out, (size_t)(p - out), deadline) == 0);
  phase = 10;
  for (;;) {
    struct pollfd live[2] = {{0, POLLIN, 0}, {pidfd, POLLIN, 0}};
    int n = poll(live, 2, -1);
    if (n < 0 && errno == EINTR) continue;
    CHECK(n >= 0);
    if (live[1].revents) { reap_owned(); CHECK(reaped); break; }
    if (live[0].revents) { cleanup(); break; } /* close/cancel revokes only this launch */
  }
  p = out; put32(&p, child); put32(&p, reaped); put32(&p, (uint32_t)child_status); put64(&p, now_ns());
  emit(EXITED, out, (size_t)(p - out), now_ns() + 250000000u);
  if (init_bytes) wipe(init_bytes, init_size);
  return reaped ? 0 : 1;
}
