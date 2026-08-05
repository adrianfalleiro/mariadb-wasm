/*
  Generation-tagged handle table.

  JavaScript will hold these integers across async boundaries and will
  occasionally use one after closing it. A plain index would silently alias
  whatever object later reused the slot — a use-after-free expressed as a
  wrong answer from the database. The generation tag turns that into a
  deterministic MDB_ERR_BAD_HANDLE.
*/
#ifndef MARIADB_WASM_HANDLES_H
#define MARIADB_WASM_HANDLES_H

#include <cstdint>
#include <memory>
#include <mutex>
#include <vector>

namespace mdb {

/* handle = (generation << kIndexBits) | (index + 1)

   The +1 keeps 0 permanently invalid, so a zero-initialised JS field is never
   mistaken for a live handle. 20 index bits caps us at ~1M live objects of a
   kind, which is far past anything a test suite will hold, and leaves 12
   generation bits — enough that a stale handle would have to survive 4096
   reuses of the same slot to alias. */
template <typename T>
class HandleTable {
 public:
  static constexpr uint32_t kIndexBits = 20;
  static constexpr uint32_t kIndexMask = (1u << kIndexBits) - 1u;
  static constexpr uint32_t kMaxEntries = kIndexMask;  /* index+1 must fit */

  uint32_t insert(std::unique_ptr<T> value) {
    std::lock_guard<std::mutex> lock(mutex_);

    size_t index;
    if (!free_list_.empty()) {
      index = free_list_.back();
      free_list_.pop_back();
    } else {
      if (slots_.size() >= kMaxEntries)
        return 0;
      slots_.emplace_back();
      index = slots_.size() - 1;
    }

    Slot &slot = slots_[index];
    slot.value = std::move(value);
    /* Bump on acquire so a handle freed and reacquired never repeats. */
    slot.generation = (slot.generation + 1) & kGenerationMask;
    live_++;

    return (slot.generation << kIndexBits) | static_cast<uint32_t>(index + 1);
  }

  /* Borrowed pointer, or nullptr if the handle is unknown or stale. The
     caller must hold no assumption about lifetime beyond the current call —
     see the note on locking below. */
  T *get(uint32_t handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    Slot *slot = resolve(handle);
    return slot ? slot->value.get() : nullptr;
  }

  /* Removes the entry and returns it, so the caller can run destruction
     (which may call into MariaDB and block) without holding the table lock. */
  std::unique_ptr<T> remove(uint32_t handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    Slot *slot = resolve(handle);
    if (!slot)
      return nullptr;

    std::unique_ptr<T> value = std::move(slot->value);
    free_list_.push_back((handle & kIndexMask) - 1);
    live_--;
    return value;
  }

  /* Drains the table. Used at shutdown, where anything still present is a
     leak the caller wants to report and then clean up. */
  std::vector<std::unique_ptr<T>> drain() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::unique_ptr<T>> out;
    for (size_t i = 0; i < slots_.size(); i++) {
      if (slots_[i].value) {
        out.push_back(std::move(slots_[i].value));
        free_list_.push_back(i);
      }
    }
    live_ = 0;
    return out;
  }

  uint32_t live() {
    std::lock_guard<std::mutex> lock(mutex_);
    return live_;
  }

 private:
  static constexpr uint32_t kGenerationMask = (1u << (32 - kIndexBits)) - 1u;

  struct Slot {
    std::unique_ptr<T> value;
    uint32_t generation = 0;
  };

  /* Caller holds mutex_. */
  Slot *resolve(uint32_t handle) {
    uint32_t packed_index = handle & kIndexMask;
    if (packed_index == 0)
      return nullptr;

    size_t index = packed_index - 1;
    if (index >= slots_.size())
      return nullptr;

    Slot &slot = slots_[index];
    if (!slot.value)
      return nullptr;
    if (slot.generation != (handle >> kIndexBits))
      return nullptr;

    return &slot;
  }

  std::mutex mutex_;
  std::vector<Slot> slots_;
  std::vector<size_t> free_list_;
  uint32_t live_ = 0;
};

}  // namespace mdb

#endif  /* MARIADB_WASM_HANDLES_H */
