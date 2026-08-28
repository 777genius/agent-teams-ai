#include <node_api.h>

#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>

#include "platform.h"

namespace desktop_file_lock {
namespace {

constexpr const char* kInvalidArgument = "ERR_FILE_LOCK_INVALID_ARGUMENT";
constexpr const char* kInvalidScope = "ERR_FILE_LOCK_INVALID_SCOPE";
constexpr const char* kInvalidLease = "ERR_FILE_LOCK_INVALID_LEASE";
constexpr const char* kScopeBusy = "ERR_FILE_LOCK_SCOPE_BUSY";
constexpr const char* kOwnershipLost = "ERR_FILE_LOCK_OWNERSHIP_LOST";
constexpr const char* kUncertain = "ERR_FILE_LOCK_UNCERTAIN";
constexpr const char* kUnsupported = "ERR_FILE_LOCK_UNSUPPORTED";
constexpr const char* kInternal = "ERR_FILE_LOCK_INTERNAL";

struct LeaseEntry {
  uint64_t scope_id;
  std::unique_ptr<PlatformLease> lease;
};

struct State {
  std::mutex mutex;
  uint64_t next_scope = 1;
  uint64_t next_lease = 1;
  std::unordered_map<uint64_t, std::unique_ptr<PlatformScope>> scopes;
  std::unordered_map<uint64_t, LeaseEntry> leases;
};

void Throw(napi_env env, const char* code, const std::string& message) {
  napi_value code_value;
  napi_value message_value;
  napi_value error;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_create_string_utf8(env, message.c_str(), message.size(), &message_value);
  napi_create_error(env, code_value, message_value, &error);
  napi_throw(env, error);
}

const char* CodeFor(const Result& result) {
  if (result.kind == ResultKind::kUnsupported) return kUnsupported;
  if (result.kind == ResultKind::kUncertain) return kUncertain;
  return kInternal;
}

bool GetString(napi_env env, napi_value value, std::string* output) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  output->resize(length + 1);
  size_t copied = 0;
  bool valid = napi_get_value_string_utf8(env, value, output->data(), length + 1, &copied) == napi_ok &&
               copied == length;
  output->resize(length);
  return valid;
}

bool GetId(napi_env env, napi_value value, uint64_t* output) {
  napi_valuetype type;
  bool lossless = false;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_bigint ||
      napi_get_value_bigint_uint64(env, value, output, &lossless) != napi_ok) {
    return false;
  }
  return lossless && *output != 0;
}

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

napi_value BigInt(napi_env env, uint64_t value) {
  napi_value result;
  napi_create_bigint_uint64(env, value, &result);
  return result;
}

bool ReadArguments(napi_env env, napi_callback_info info, size_t expected,
                   napi_value* arguments, void** data = nullptr) {
  size_t count = expected;
  napi_value self;
  if (napi_get_cb_info(env, info, &count, arguments, &self, data) != napi_ok ||
      count != expected) {
    Throw(env, kInvalidArgument, "Invalid native file-lock argument count");
    return false;
  }
  return true;
}

State* GetState(napi_env env, napi_callback_info info, size_t expected,
                napi_value* arguments) {
  void* data = nullptr;
  if (!ReadArguments(env, info, expected, arguments, &data)) return nullptr;
  return static_cast<State*>(data);
}

napi_value CaptureScope(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  State* state = GetState(env, info, 1, arguments);
  if (!state) return nullptr;
  std::string root;
  if (!GetString(env, arguments[0], &root) || root.empty()) {
    Throw(env, kInvalidArgument, "authorityRoot must be a non-empty string");
    return nullptr;
  }
  std::unique_ptr<PlatformScope> scope;
  Result result = CapturePlatformScope(root, &scope);
  if (result.kind != ResultKind::kAcquired) {
    Throw(env, CodeFor(result), result.message);
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(state->mutex);
  uint64_t id = state->next_scope++;
  if (id == 0) id = state->next_scope++;
  state->scopes.emplace(id, std::move(scope));
  return BigInt(env, id);
}

napi_value StatusResult(napi_env env, const Result& result) {
  const char* status = result.kind == ResultKind::kContended ? "contended" :
                       result.kind == ResultKind::kUnsupported ? "unsupported" : "uncertain";
  napi_value object;
  napi_value status_value;
  napi_value message_value;
  napi_create_object(env, &object);
  napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &status_value);
  napi_create_string_utf8(env, result.message.c_str(), result.message.size(), &message_value);
  napi_set_named_property(env, object, "status", status_value);
  napi_set_named_property(env, object, "message", message_value);
  return object;
}

napi_value TryAcquire(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  State* state = GetState(env, info, 3, arguments);
  if (!state) return nullptr;
  uint64_t scope_id;
  std::string target;
  std::string marker;
  if (!GetId(env, arguments[0], &scope_id) || !GetString(env, arguments[1], &target) ||
      !GetString(env, arguments[2], &marker)) {
    Throw(env, kInvalidArgument, "tryAcquire expects (bigint, string, string)");
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(state->mutex);
  auto scope = state->scopes.find(scope_id);
  if (scope == state->scopes.end()) {
    Throw(env, kInvalidScope, "Unknown or closed native file-lock scope");
    return nullptr;
  }
  std::unique_ptr<PlatformLease> lease;
  Result result = scope->second->TryAcquire(target, marker, &lease);
  if (result.kind != ResultKind::kAcquired) return StatusResult(env, result);
  uint64_t lease_id = state->next_lease++;
  if (lease_id == 0) lease_id = state->next_lease++;
  std::string owner_key = lease->OwnerKey();
  state->leases.emplace(lease_id, LeaseEntry{scope_id, std::move(lease)});
  napi_value object;
  napi_value status;
  napi_value owner;
  napi_create_object(env, &object);
  napi_create_string_utf8(env, "acquired", NAPI_AUTO_LENGTH, &status);
  napi_create_string_utf8(env, owner_key.c_str(), owner_key.size(), &owner);
  napi_set_named_property(env, object, "status", status);
  napi_set_named_property(env, object, "leaseId", BigInt(env, lease_id));
  napi_set_named_property(env, object, "ownerKey", owner);
  return object;
}

napi_value AssertOwned(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  State* state = GetState(env, info, 1, arguments);
  if (!state) return nullptr;
  uint64_t id;
  if (!GetId(env, arguments[0], &id)) {
    Throw(env, kInvalidArgument, "leaseId must be a positive bigint");
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(state->mutex);
  auto lease = state->leases.find(id);
  if (lease == state->leases.end()) {
    Throw(env, kInvalidLease, "Unknown or released native file-lock lease");
    return nullptr;
  }
  Result result = lease->second.lease->AssertOwned();
  if (result.kind != ResultKind::kAcquired) {
    Throw(env, kOwnershipLost, result.message);
    return nullptr;
  }
  return Undefined(env);
}

napi_value PublishRelease(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  State* state = GetState(env, info, 2, arguments);
  if (!state) return nullptr;
  uint64_t id;
  std::string record;
  if (!GetId(env, arguments[0], &id) || !GetString(env, arguments[1], &record)) {
    Throw(env, kInvalidArgument, "publishRelease expects (bigint, string)");
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(state->mutex);
  auto lease = state->leases.find(id);
  if (lease == state->leases.end()) {
    Throw(env, kInvalidLease, "Unknown or released native file-lock lease");
    return nullptr;
  }
  Result result = lease->second.lease->PublishRelease(record);
  if (result.kind != ResultKind::kAcquired) {
    Throw(env, CodeFor(result), result.message);
    return nullptr;
  }
  return Undefined(env);
}

napi_value Settle(napi_env env, napi_callback_info info, bool verify) {
  napi_value arguments[1];
  State* state = GetState(env, info, 1, arguments);
  if (!state) return nullptr;
  uint64_t id;
  if (!GetId(env, arguments[0], &id)) {
    Throw(env, kInvalidArgument, "leaseId must be a positive bigint");
    return nullptr;
  }
  std::unique_ptr<PlatformLease> owned;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    auto lease = state->leases.find(id);
    if (lease == state->leases.end()) {
      Throw(env, kInvalidLease, "Unknown or released native file-lock lease");
      return nullptr;
    }
    owned = std::move(lease->second.lease);
    state->leases.erase(lease);
  }
  Result result = owned->Release(verify);
  if (result.kind != ResultKind::kAcquired) {
    Throw(env, verify ? kOwnershipLost : CodeFor(result), result.message);
    return nullptr;
  }
  return Undefined(env);
}

napi_value Release(napi_env env, napi_callback_info info) {
  return Settle(env, info, true);
}

napi_value Abandon(napi_env env, napi_callback_info info) {
  return Settle(env, info, false);
}

napi_value CloseScope(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  State* state = GetState(env, info, 1, arguments);
  if (!state) return nullptr;
  uint64_t id;
  if (!GetId(env, arguments[0], &id)) {
    Throw(env, kInvalidArgument, "scopeId must be a positive bigint");
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(state->mutex);
  auto scope = state->scopes.find(id);
  if (scope == state->scopes.end()) {
    Throw(env, kInvalidScope, "Unknown or closed native file-lock scope");
    return nullptr;
  }
  for (const auto& entry : state->leases) {
    if (entry.second.scope_id == id) {
      Throw(env, kScopeBusy, "Cannot close a native file-lock scope with active leases");
      return nullptr;
    }
  }
  state->scopes.erase(scope);
  return Undefined(env);
}

void Cleanup(void* pointer) {
  State* state = static_cast<State*>(pointer);
  // Destructors close native handles. No path is unlinked or rewritten during cleanup.
  state->leases.clear();
  state->scopes.clear();
  delete state;
}

napi_value Initialize(napi_env env, napi_value exports) {
  State* state = new State();
  if (napi_add_env_cleanup_hook(env, Cleanup, state) != napi_ok) {
    delete state;
    Throw(env, kInternal, "Unable to register native file-lock cleanup");
    return nullptr;
  }
  napi_property_descriptor properties[] = {
      {"captureScope", nullptr, CaptureScope, nullptr, nullptr, nullptr, napi_default, state},
      {"tryAcquire", nullptr, TryAcquire, nullptr, nullptr, nullptr, napi_default, state},
      {"assertOwned", nullptr, AssertOwned, nullptr, nullptr, nullptr, napi_default, state},
      {"publishRelease", nullptr, PublishRelease, nullptr, nullptr, nullptr, napi_default, state},
      {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, state},
      {"abandon", nullptr, Abandon, nullptr, nullptr, nullptr, napi_default, state},
      {"closeScope", nullptr, CloseScope, nullptr, nullptr, nullptr, napi_default, state},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace
}  // namespace desktop_file_lock

NAPI_MODULE(NODE_GYP_MODULE_NAME, desktop_file_lock::Initialize)
