/* Runtime lifecycle: mysql_server_init/end, global error channel, leak counts. */
#include "internal.h"

#include <atomic>
#include <cstring>
#include <mutex>

namespace mdb {

namespace {

/* MariaDB's embedded server init is process-global, so the runtime state is
   too. One initialised server per module instance is the documented model;
   independent runtimes mean independent wasm instances. */
std::atomic<bool> g_ready{false};

struct GlobalError {
  std::mutex mutex;
  uint32_t code = 0;
  std::string sql_state;
  std::string message;
};

/* Function-local statics rather than file-scope objects: initialisation order
   is then defined even if a static constructor elsewhere in the merged archive
   calls into the wrapper. */
GlobalError &global_error() {
  static GlobalError instance;
  return instance;
}

}  // namespace

HandleTable<Connection> &connections() {
  static HandleTable<Connection> instance;
  return instance;
}

HandleTable<Result> &results() {
  static HandleTable<Result> instance;
  return instance;
}

bool runtime_ready() { return g_ready.load(std::memory_order_acquire); }

void set_global_error(uint32_t code, const char *sql_state, const char *message) {
  GlobalError &error = global_error();
  std::lock_guard<std::mutex> lock(error.mutex);
  error.code = code;
  error.sql_state = sql_state ? sql_state : "";
  error.message = message ? message : "";
}

Connection::~Connection() {
  if (mysql) {
    mysql_close(mysql);
    mysql = nullptr;
  }
}

void Connection::capture_error() {
  last_errno = mysql ? mysql_errno(mysql) : 0;
  const char *state = mysql ? mysql_sqlstate(mysql) : nullptr;
  const char *message = mysql ? mysql_error(mysql) : nullptr;
  last_sql_state = state ? state : "";
  last_message = message ? message : "";
}

void Connection::clear_error() {
  last_errno = 0;
  last_sql_state.clear();
  last_message.clear();
}

Result::~Result() {
  if (res) {
    mysql_free_result(res);
    res = nullptr;
  }
}

}  // namespace mdb

extern "C" {

int mdb_runtime_init(int argc, const char *const *argv) {
  MDB_GUARD_BEGIN

  if (mdb::runtime_ready()) {
    mdb::set_global_error(0, "HY000", "runtime already initialised");
    return MDB_ERR_BAD_STATE;
  }

  /* mysql_server_init takes a conventional argv whose first entry is the
     program name and is ignored as an option. Building that here keeps the
     detail out of the JavaScript layer. */
  std::vector<std::string> owned;
  owned.reserve(static_cast<size_t>(argc < 0 ? 0 : argc) + 1);
  owned.emplace_back("mariadb_wasm");
  for (int i = 0; i < argc; i++)
    owned.emplace_back(argv && argv[i] ? argv[i] : "");

  std::vector<char *> server_args;
  server_args.reserve(owned.size());
  for (std::string &arg : owned)
    server_args.push_back(const_cast<char *>(arg.c_str()));

  /* The option groups mysqld itself reads. With --no-defaults nothing is
     loaded, but passing them keeps option parsing identical to the native
     reference, which is the whole point of having a reference. */
  static char group_embedded[] = "embedded";
  static char group_server[] = "server";
  char *server_groups[] = {group_embedded, group_server, nullptr};

  if (mysql_server_init(static_cast<int>(server_args.size()),
                        server_args.data(), server_groups) != 0) {
    mdb::set_global_error(0, "HY000", "mysql_server_init failed");
    return MDB_ERR_MYSQL;
  }

  /* Force the handle tables into existence before any connection can race on
     first use. */
  mdb::connections();
  mdb::results();

  mdb::set_runtime_ready(true);
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_runtime_shutdown(void) {
  MDB_GUARD_BEGIN

  if (!mdb::runtime_ready())
    return MDB_OK;  /* idempotent: shutting down a dead runtime is not an error */

  /* Results before connections: a MYSQL_RES holds memory owned by its
     connection, and closing a connection that still has live results is
     exactly the shape that leaks or double-frees. */
  mdb::results().drain().clear();
  mdb::connections().drain().clear();

  mdb::set_runtime_ready(false);
  mysql_server_end();
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_runtime_is_ready(void) { return mdb::runtime_ready() ? 1 : 0; }

int mdb_last_global_error(mdb_error *out_error) {
  if (!out_error)
    return MDB_ERR_BAD_HANDLE;

  MDB_GUARD_BEGIN

  mdb::fill_global_error(out_error);
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

uint32_t mdb_live_connections(void) { return mdb::connections().live(); }
uint32_t mdb_live_results(void) { return mdb::results().live(); }
uint32_t mdb_live_statements(void) { return 0; }  /* until prepared statements land */

}  // extern "C"

namespace mdb {

void set_runtime_ready(bool ready) {
  g_ready.store(ready, std::memory_order_release);
}

/* The strings must outlive the call, so they are handed out as pointers into
   the long-lived GlobalError rather than into a temporary. They stay valid
   until the next set_global_error. */
void fill_global_error(mdb_error *out_error) {
  GlobalError &error = global_error();
  std::lock_guard<std::mutex> lock(error.mutex);
  out_error->code = error.code;
  out_error->sql_state = error.sql_state.c_str();
  out_error->message = error.message.c_str();
}

}  // namespace mdb
