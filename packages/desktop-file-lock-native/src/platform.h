#ifndef AGENT_TEAMS_DESKTOP_FILE_LOCK_PLATFORM_H_
#define AGENT_TEAMS_DESKTOP_FILE_LOCK_PLATFORM_H_

#include <cstdint>
#include <memory>
#include <string>

namespace desktop_file_lock {

constexpr size_t kMaxActiveMarkerBytes = 4096;
constexpr size_t kMaxReleaseRecordBytes = 4096;
constexpr size_t kMaxMarkerBytes = 8192;
constexpr size_t kMaxRelativeTargetBytes = 4096;

enum class ResultKind { kAcquired, kContended, kUncertain, kUnsupported };

struct Result {
  ResultKind kind = ResultKind::kUncertain;
  std::string message;
};

class PlatformLease {
 public:
  virtual ~PlatformLease() = default;
  virtual Result AssertOwned() = 0;
  virtual Result PublishRelease(const std::string& record) = 0;
  virtual Result Release(bool verify) = 0;
  virtual const std::string& OwnerKey() const = 0;
};

class PlatformScope {
 public:
  virtual ~PlatformScope() = default;
  virtual Result TryAcquire(const std::string& relative_target,
                            const std::string& active_marker,
                            std::unique_ptr<PlatformLease>* lease) = 0;
};

Result CapturePlatformScope(const std::string& authority_root,
                            std::unique_ptr<PlatformScope>* scope);

}  // namespace desktop_file_lock

#endif
