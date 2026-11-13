#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#if defined(__linux__)
#include <elf.h>
#include <sys/auxv.h>
#include <sys/ptrace.h>
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecBase.h>
#include <Security/SecCode.h>
#include <libproc.h>
#include <mach/mach.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#else
#error This TEST actor qualifies only Linux and Darwin.
#endif

/* TEST only. Never compiled into or staged with a product process adapter. */
#if defined(TEST_LIBRARY) || defined(TEST_PAYLOAD_TAG)
static void marker(const char *value) {
  const char *path = getenv("TEST_POSIX_MARKER");
  if (!path) _exit(90);
  int fd = open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0 || write(fd, value, strlen(value)) != (ssize_t)strlen(value) || close(fd)) _exit(91);
}
#ifdef TEST_LIBRARY
__attribute__((constructor)) static void library_first(void) { marker("LIB\n"); }
int test_sibling_value(void) { return 17; }
#else
extern int test_sibling_value(void);
__attribute__((constructor)) static void payload_first(void) { marker("BIN:" TEST_PAYLOAD_TAG "\n"); }
int main(int argc, char **argv) {
  char cwd[PATH_MAX], sibling[PATH_MAX], asset[64] = {0};
  if (argc != 3 || !getcwd(cwd, sizeof(cwd)) || strlen(argv[0]) >= sizeof(sibling)) return 92;
  strcpy(sibling, argv[0]);
  char *slash = strrchr(sibling, '/');
  if (!slash || (size_t)(slash+1-sibling)+sizeof("payload-root.txt")>sizeof(sibling)) return 93;
  strcpy(slash + 1, "payload-root.txt");
  int fd = open(sibling, O_RDONLY | O_CLOEXEC);
  if (fd < 0 || read(fd, asset, sizeof(asset)-1) <= 0 || close(fd)) return 94;
  marker("MAIN:" TEST_PAYLOAD_TAG "\n");
  printf("tag=%s\nargv0=%s\narg1=%s\narg2=%s\nenv=%s\ncwd=%s\nasset=%s\nshared=%d\n",
    TEST_PAYLOAD_TAG, argv[0], argv[1], argv[2], getenv("TEST_POSIX_VALUE"), cwd, asset, test_sibling_value());
#ifdef __linux__
  printf("execfn=%s\n", (const char *)getauxval(AT_EXECFN));
#endif
  return 0;
}
#endif
#else
extern char **environ;
static volatile sig_atomic_t target_pid, hash_pid, interrupted;
static int target_status, target_reaped, hash_status;
static double deadline;
static void cancelled(int signal_number) {
  (void)signal_number;
  interrupted = 1;
  if (target_pid > 1) (void)kill((pid_t)target_pid, SIGKILL);
  if (hash_pid > 1) (void)kill((pid_t)hash_pid, SIGKILL);
}
static double monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
  return (double)now.tv_sec * 1000 + (double)now.tv_nsec / 1000000;
}
static int remaining(void) {
  double value = deadline - monotonic_ms();
  return interrupted || value <= 0 ? 0 : value > 15000 ? 15000 : (int)value;
}
/* Block the cancellation handler between original waitpid and retiring its PID. */
static int wait_original(volatile sig_atomic_t *slot, int *status, int allow_stop) {
  while (remaining()) {
    sigset_t mask, old;
    sigemptyset(&mask); sigaddset(&mask, SIGTERM); sigaddset(&mask, SIGINT);
    if (sigprocmask(SIG_BLOCK, &mask, &old)) return errno;
    pid_t pid = (pid_t)*slot;
    pid_t result = waitpid(pid, status, WNOHANG | (allow_stop ? WUNTRACED : 0));
    int code = errno;
    if (result == pid && (WIFEXITED(*status) || WIFSIGNALED(*status))) *slot = 0;
    if (sigprocmask(SIG_SETMASK, &old, NULL)) return errno;
    if (result == pid) return 0;
    if (result < 0 && code != EINTR) return code;
    struct timespec pause = {0, 2000000};
    (void)nanosleep(&pause, NULL);
  }
  return ETIMEDOUT;
}
static int finish_original(volatile sig_atomic_t *slot, int *status) {
  if (*slot == 0) return 0;
  (void)kill((pid_t)*slot, SIGKILL);
  /* Bounded cleanup is separate from resuming any selected instructions. */
  double saved = deadline; sig_atomic_t stopped = interrupted;
  interrupted = 0; deadline = monotonic_ms() + 3000;
  int code = wait_original(slot, status, 0);
  deadline = saved; interrupted = stopped;
  return code;
}
static int hash_fd(int fd, char out[65]) {
  struct stat before, after;
  if (fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_size <= 0 || before.st_size > 2*1024*1024 || lseek(fd, 0, SEEK_SET) < 0) return EINVAL;
  int pipes[2];
  if (pipe(pipes)) return errno;
  pid_t child = fork();
  if (child == 0) {
    (void)close(pipes[0]);
    if (dup2(fd, STDIN_FILENO) < 0 || dup2(pipes[1], STDOUT_FILENO) < 0) _exit(95);
    (void)close(pipes[1]);
#ifdef __APPLE__
    execl("/usr/bin/shasum", "shasum", "-a", "256", (char *)NULL);
#else
    execl("/usr/bin/sha256sum", "sha256sum", (char *)NULL);
#endif
    _exit(96);
  }
  int error = child < 0 ? errno : 0;
  (void)close(pipes[1]);
  if (child > 0) hash_pid = child;
  char bytes[129] = {0}; size_t length = 0;
  while (!error && length < sizeof(bytes)-1) {
    struct pollfd pending = {pipes[0], POLLIN, 0};
    int ready = poll(&pending, 1, remaining());
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) { error = ready == 0 ? ETIMEDOUT : errno; break; }
    ssize_t count = read(pipes[0], bytes+length, sizeof(bytes)-1-length);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { error = errno; break; }
    if (!count) break;
    length += (size_t)count;
  }
  (void)close(pipes[0]);
  if (!error) error = wait_original(&hash_pid, &hash_status, 0);
  if (hash_pid) { int cleanup = finish_original(&hash_pid, &hash_status); if (!error) error = cleanup; }
  if (error) return error;
  if (!WIFEXITED(hash_status) || WEXITSTATUS(hash_status) != 0 || length < 66 || length >= sizeof(bytes)-1) return EIO;
  for (int i=0; i<64; i++) if (!((bytes[i]>='0' && bytes[i]<='9') || (bytes[i]>='a' && bytes[i]<='f'))) return EINVAL;
  if (fstat(fd, &after) || before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_size != after.st_size || before.st_mtime != after.st_mtime || before.st_ctime != after.st_ctime) return ESTALE;
#ifdef __APPLE__
  if (before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec || before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec) return ESTALE;
#else
  if (before.st_mtim.tv_nsec != after.st_mtim.tv_nsec || before.st_ctim.tv_nsec != after.st_ctim.tv_nsec) return ESTALE;
#endif
  memcpy(out, bytes, 64); out[64] = 0;
  return 0;
}
struct identity {
  pid_t pid, ppid, pgid, sid;
  uint64_t birth;
#ifdef __APPLE__
  audit_token_t token;
#endif
};
#ifdef __APPLE__
static int token_of(pid_t pid, audit_token_t *token) {
  mach_port_t port = MACH_PORT_NULL;
  kern_return_t result = task_name_for_pid(mach_task_self(), pid, &port);
  if (result != KERN_SUCCESS || port == MACH_PORT_NULL) return EACCES;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  result = task_info(port, TASK_AUDIT_TOKEN, (task_info_t)token, &count);
  kern_return_t released = mach_port_deallocate(mach_task_self(), port);
  return result == KERN_SUCCESS && released == KERN_SUCCESS && count == TASK_AUDIT_TOKEN_COUNT && token->val[5] == (uint32_t)pid ? 0 : EACCES;
}
#endif
static int identity_of(pid_t pid, struct identity *out) {
  memset(out, 0, sizeof(*out));
  out->pid = pid; out->pgid = getpgid(pid); out->sid = getsid(pid);
#ifdef __APPLE__
  struct proc_bsdinfo bsd; struct rusage_info_v0 usage; audit_token_t after;
  if (token_of(pid, &out->token) || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd)) != (int)sizeof(bsd) || bsd.pbi_pid != (uint32_t)pid ||
      proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&usage) || usage.ri_proc_exit_abstime || token_of(pid, &after) || memcmp(&out->token, &after, sizeof(after))) return ESRCH;
  out->ppid = (pid_t)bsd.pbi_ppid; out->birth = usage.ri_proc_start_abstime;
#else
  char path[64], text[4096];
  (void)snprintf(path, sizeof(path), "/proc/%d/stat", (int)pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return errno;
  ssize_t n = read(fd, text, sizeof(text)-1); (void)close(fd);
  if (n <= 0) return EIO;
  text[n] = 0;
  char *start = strrchr(text, ')'), *save = NULL;
  if (!start || start[1] != ' ') return EINVAL;
  int field = 3;
  for (char *part = strtok_r(start+2, " ", &save); part; part = strtok_r(NULL, " ", &save), field++) {
    if (field == 4) out->ppid = (pid_t)strtol(part, NULL, 10);
    if (field == 22) { out->birth = strtoull(part, NULL, 10); break; }
  }
#endif
  return out->ppid == getpid() && out->pgid == pid && out->sid == pid && out->birth ? 0 : EACCES;
}
static int original_image(const struct identity *original, char path[PATH_MAX], unsigned *cs_flags) {
#ifdef __APPLE__
  CFDataRef token = NULL; CFDictionaryRef attributes = NULL, signing = NULL;
  SecCodeRef guest = NULL; CFURLRef executable = NULL; int error = EACCES;
  char signed_path[PATH_MAX] = {0};
  if (proc_pidpath_audittoken((audit_token_t *)&original->token, path, PATH_MAX) <= 0) return EACCES;
  token = CFDataCreate(kCFAllocatorDefault, (const UInt8 *)&original->token, sizeof(original->token));
  if (!token) goto done;
  const void *keys[] = {kSecGuestAttributeAudit}, *values[] = {token};
  attributes = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  if (!attributes || SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &guest) != errSecSuccess ||
      SecCodeCheckValidity(guest, kSecCSNoNetworkAccess, NULL) != errSecSuccess ||
      SecCodeCopyPath((SecStaticCodeRef)guest, kSecCSDefaultFlags, &executable) != errSecSuccess ||
      !CFURLGetFileSystemRepresentation(executable, 1, (UInt8 *)signed_path, sizeof(signed_path)) || strcmp(path, signed_path)) goto done;
  if (SecCodeCopySigningInformation((SecStaticCodeRef)guest, kSecCSDynamicInformation, &signing) != errSecSuccess) goto done;
  CFNumberRef status = CFDictionaryGetValue(signing, kSecCodeInfoStatus);
  if (!status || CFGetTypeID(status) != CFNumberGetTypeID() || !CFNumberGetValue(status, kCFNumberIntType, cs_flags)) goto done;
  error = 0;
done:
  if (signing) CFRelease(signing);
  if (executable) CFRelease(executable);
  if (guest) CFRelease(guest);
  if (attributes) CFRelease(attributes);
  if (token) CFRelease(token);
  return error;
#else
  (void)cs_flags;
  (void)snprintf(path, PATH_MAX, "/proc/%d/exe", (int)original->pid);
  return 0;
#endif
}
static int rewrite_fd(int output, const char *replacement) {
  int source = open(replacement, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (source < 0) return errno;
  struct stat info;
  int error = fstat(source, &info) || !S_ISREG(info.st_mode) || info.st_size <= 0 || info.st_size > 2*1024*1024 ? EINVAL : 0;
  if (!error && lseek(output, 0, SEEK_SET) < 0) error = errno;
  char bytes[65536]; ssize_t count = 0;
  while (!error && (count = read(source, bytes, sizeof(bytes))) > 0) {
    if (write(output, bytes, (size_t)count) != count) error = EIO;
  }
  if (!error && count < 0) error = errno;
  if (!error && (ftruncate(output, info.st_size) || fsync(output))) error = errno;
  (void)close(source);
  return error;
}
static int rewrite(const char *path, const char *replacement) {
  int output = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (output < 0) return errno;
  int error = rewrite_fd(output, replacement);
  (void)close(output);
  return error;
}
#ifdef __linux__
static _Noreturn void report_exec_error(int fd, int code, int exit_code) {
  ssize_t count = write(fd, &code, sizeof(code));
  _exit(count == (ssize_t)sizeof(code) ? exit_code : 113);
}
/* Read only after the original child is reaped and the parent's write end is closed. */
static int read_exec_error(int fd, int *captured) {
  int code = 0;
  *captured = 0;
  ssize_t count = read(fd, &code, sizeof(code));
  if (count < 0) return errno;
  if (count != (ssize_t)sizeof(code) || code <= 0) return EIO;
  *captured = code;
  return code;
}
#endif
int main(int argc, char **argv) {
  if (argc != 8) return 2;
  const char *mode = argv[1], *selected = argv[2], *replacement = argv[3], *expected = argv[4], *marker_path = argv[5], *output_path = argv[6], *cwd = argv[7];
  if (strcmp(mode,"baseline") && strcmp(mode,"rename") && strcmp(mode,"inplace") && strcmp(mode,"after-check") && strcmp(mode,"writer-open") && strcmp(mode,"script-negative") && strcmp(mode,"plain")) return 2;
  if (strlen(expected) != 64 || selected[0] != '/' || replacement[0] != '/' || marker_path[0] != '/' || output_path[0] != '/' || cwd[0] != '/') return 2;
  deadline = monotonic_ms() + 15000;
  struct sigaction action; memset(&action,0,sizeof(action)); action.sa_handler = cancelled;
  if (sigaction(SIGTERM,&action,NULL) || sigaction(SIGINT,&action,NULL)) return 2;
  const char *stage = "capture"; int error = 0, mutation_error = -1, exec_error = 0;
  int retained = -1, image_fd = -1, writer = -1, output = -1, errors[2] = {-1,-1};
  int spawned = 0, stopped = 0, resumed = 0, matched = 0, absent_before = 0, image_observed = 0;
  unsigned cs_flags = 0; pid_t original_pid = 0;
  char original_hash[65] = {0}, kernel_hash[65] = {0}, image_path[PATH_MAX] = {0};
  struct stat captured_stat, image_stat; memset(&captured_stat,0,sizeof(captured_stat)); memset(&image_stat,0,sizeof(image_stat));
  struct identity before, after; memset(&before,0,sizeof(before));
  retained = open(selected, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (retained < 0 || fstat(retained,&captured_stat) || (error = hash_fd(retained,original_hash)) || strcmp(original_hash,expected)) { if (!error) error = EINVAL; goto finish; }
  stage = "pre-exec-mutation";
  if (!strcmp(mode,"rename") && rename(replacement,selected)) { error=errno; goto finish; }
  if (!strcmp(mode,"inplace") && (error=rewrite(selected,replacement))) goto finish;
  if (!strcmp(mode,"writer-open")) { writer=open(selected,O_WRONLY|O_CLOEXEC|O_NOFOLLOW); if(writer<0){error=errno;goto finish;} }
  output = open(output_path,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0600);
  if(output<0 || pipe(errors)){error=errno;goto finish;}
  (void)fcntl(errors[1],F_SETFD,FD_CLOEXEC);
  stage = "spawn";
  char *args[] = {(char *)selected,"--version","TEST argument with spaces",NULL};
#ifdef __APPLE__
  posix_spawnattr_t attr; posix_spawn_file_actions_t files;
  if ((error=posix_spawnattr_init(&attr))) goto finish;
  if ((error=posix_spawn_file_actions_init(&files))) { posix_spawnattr_destroy(&attr); goto finish; }
  short flags = POSIX_SPAWN_SETSID | (strcmp(mode,"plain") ? POSIX_SPAWN_START_SUSPENDED : 0);
  error=posix_spawnattr_setflags(&attr,flags);
  if(!error) error=posix_spawn_file_actions_adddup2(&files,output,STDOUT_FILENO);
  if(!error) error=posix_spawn_file_actions_adddup2(&files,output,STDERR_FILENO);
  if(!error && chdir(cwd)) error=errno;
  if(!error) error=posix_spawn(&original_pid,selected,&files,&attr,args,environ);
  posix_spawn_file_actions_destroy(&files); posix_spawnattr_destroy(&attr);
  if(error){exec_error=error;goto finish;}
  target_pid=original_pid; spawned=1;
  if(strcmp(mode,"plain")){
    stage="spawn-suspended";
    if((error=wait_original(&target_pid,&target_status,1))) goto finish;
    if(!target_pid || !WIFSTOPPED(target_status)){error=EPROTO;goto finish;}
    stopped=1;
  }
#else
  original_pid=fork();
  if(original_pid==0){
    (void)close(errors[0]);
    if(dup2(output,STDOUT_FILENO)<0 || dup2(output,STDERR_FILENO)<0 || setsid()<0 || chdir(cwd)) _exit(110);
    if(strcmp(mode,"plain") && ptrace(PTRACE_TRACEME,0,NULL,NULL)<0) report_exec_error(errors[1],errno,111);
    if(strcmp(mode,"plain")) (void)raise(SIGSTOP);
    execve(selected,args,environ);
    report_exec_error(errors[1],errno,112);
  }
  if(original_pid<0){error=errno;goto finish;}
  target_pid=original_pid; spawned=1;
  (void)close(errors[1]);errors[1]=-1;
  if(strcmp(mode,"plain")){
    stage="trace-initial";
    if((error=wait_original(&target_pid,&target_status,1))) goto finish;
    if(!target_pid){target_reaped=1;error=read_exec_error(errors[0],&exec_error);goto finish;}
    if(!WIFSTOPPED(target_status)||WSTOPSIG(target_status)!=SIGSTOP){error=EPROTO;goto finish;}
    if((error=identity_of(original_pid,&before))) goto finish;
    if(ptrace(PTRACE_SETOPTIONS,original_pid,NULL,(void *)(uintptr_t)(PTRACE_O_TRACEEXEC|PTRACE_O_EXITKILL))<0 || ptrace(PTRACE_CONT,original_pid,NULL,NULL)<0){error=errno;goto finish;}
    stage="trace-exec";
    if((error=wait_original(&target_pid,&target_status,1))) goto finish;
    if(!target_pid){target_reaped=1;error=read_exec_error(errors[0],&exec_error);goto finish;}
    if(!WIFSTOPPED(target_status)||WSTOPSIG(target_status)!=SIGTRAP||(unsigned)target_status>>16!=PTRACE_EVENT_EXEC){error=EPROTO;goto finish;}
    stopped=1;
  }
#endif
  if(!strcmp(mode,"plain")){resumed=1;stage="plain-exit";error=wait_original(&target_pid,&target_status,0);goto finish;}
  stage="original-identity";
  if((error=identity_of(original_pid,&after))) goto finish;
#ifdef __APPLE__
  before=after;
#else
  if(memcmp(&before,&after,sizeof(before))){error=ESTALE;goto finish;}
#endif
  absent_before=access(marker_path,F_OK)!=0 && errno==ENOENT;
  if(!absent_before){error=EPROTO;goto finish;}
  stage="kernel-image";
  if((error=original_image(&before,image_path,&cs_flags))) goto finish;
  image_fd=open(image_path,O_RDONLY|O_CLOEXEC);
  if(image_fd<0 || fstat(image_fd,&image_stat)){error=errno;goto finish;}
  if((error=hash_fd(image_fd,kernel_hash))) goto finish;
  if((error=identity_of(original_pid,&after))) goto finish;
  if(memcmp(&before,&after,sizeof(before))){error=ESTALE;goto finish;}
  image_observed=1;
  matched=captured_stat.st_dev==image_stat.st_dev && captured_stat.st_ino==image_stat.st_ino && !strcmp(original_hash,kernel_hash);
  if(!matched && strcmp(mode,"script-negative")){stage="rejected-image";goto finish;}
  if(!strcmp(mode,"after-check") || !strcmp(mode,"script-negative")) mutation_error=rewrite(selected,replacement);
  if(!strcmp(mode,"writer-open")) mutation_error=rewrite_fd(writer,replacement);
  /* Deliberately no image/path recheck after this adversary: it tests byte stability. */
  stage="resume";
#ifdef __APPLE__
  if(kill(original_pid,SIGCONT)){error=errno;goto finish;}
#else
  if(ptrace(PTRACE_DETACH,original_pid,NULL,NULL)<0){error=errno;goto finish;}
#endif
  resumed=1;
  stage="exit";error=wait_original(&target_pid,&target_status,0);
finish:
  if(hash_pid){int code=finish_original(&hash_pid,&hash_status);if(!error)error=code;}
  if(target_pid){int code=finish_original(&target_pid,&target_status);if(!error)error=code;}
  if(spawned && target_pid==0)target_reaped=1;
  if(writer>=0)(void)close(writer);
  if(image_fd>=0)(void)close(image_fd);
  if(retained>=0)(void)close(retained);
  if(output>=0)(void)close(output);
  if(errors[0]>=0)(void)close(errors[0]);
  if(errors[1]>=0)(void)close(errors[1]);
  int group_absent=original_pid>1 && kill(-original_pid,0)<0 && errno==ESRCH;
  int cleanup=hash_pid==0 && target_pid==0 && (original_pid==0 || (target_reaped && group_absent));
  printf("{\"stage\":\"%s\",\"errno\":%d,\"execErrno\":%d,\"stoppedBeforeUser\":%s,\"payloadMarkersAbsentBeforeGate\":%s,\"kernelImageObserved\":%s,\"imageMatched\":%s,\"resumed\":%s,\"mutationAfterCheckErrno\":%d,\"codeSigningFlags\":%u,\"originalPid\":%d,\"originalBirth\":\"%" PRIu64 "\",\"originalDev\":\"%" PRIu64 "\",\"originalIno\":\"%" PRIu64 "\",\"kernelDev\":\"%" PRIu64 "\",\"kernelIno\":\"%" PRIu64 "\",\"originalSha256\":\"%s\",\"kernelSha256\":\"%s\",\"exitCode\":%d,\"exitSignal\":%d,\"originalReaped\":%s,\"originalGroupAbsent\":%s,\"cleanup\":%s}\n",
    stage,error,exec_error,stopped?"true":"false",absent_before?"true":"false",image_observed?"true":"false",matched?"true":"false",resumed?"true":"false",mutation_error,cs_flags,(int)original_pid,before.birth,(uint64_t)captured_stat.st_dev,(uint64_t)captured_stat.st_ino,(uint64_t)image_stat.st_dev,(uint64_t)image_stat.st_ino,original_hash,kernel_hash,
    target_reaped && WIFEXITED(target_status)?WEXITSTATUS(target_status):-1,target_reaped && WIFSIGNALED(target_status)?WTERMSIG(target_status):0,target_reaped?"true":"false",group_absent?"true":"false",cleanup?"true":"false");
  return cleanup?0:3;
}
#endif
