/* Result-set iteration and cell access. */
#include "internal.h"

extern "C" {

uint32_t mdb_result_column_count(mdb_result_handle result) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  return res ? res->column_count : 0;

  MDB_GUARD_END(0)
}

uint64_t mdb_result_row_count(mdb_result_handle result) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  if (!res)
    return 0;

  /* Meaningful because results are buffered with mysql_store_result. */
  return static_cast<uint64_t>(mysql_num_rows(res->res));

  MDB_GUARD_END(0)
}

int mdb_result_next(mdb_result_handle result) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  if (!res)
    return -MDB_ERR_BAD_HANDLE;

  res->current_row = mysql_fetch_row(res->res);
  if (!res->current_row) {
    res->current_lengths = nullptr;
    return 0;  /* end of result set */
  }

  /* Lengths must be fetched per row; without them a value containing NUL
     bytes would be truncated by any strlen-based reader downstream. */
  res->current_lengths = mysql_fetch_lengths(res->res);
  return 1;

  MDB_GUARD_END(-MDB_ERR_INTERNAL)
}

const uint8_t *mdb_result_value_data(mdb_result_handle result, uint32_t column) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  if (!res || !res->current_row || column >= res->column_count)
    return nullptr;

  /* NULL and zero-length are different: NULL yields a null pointer here and 1
     from value_is_null, while a zero-length value yields a non-null pointer
     and length 0. */
  return reinterpret_cast<const uint8_t *>(res->current_row[column]);

  MDB_GUARD_END(nullptr)
}

size_t mdb_result_value_length(mdb_result_handle result, uint32_t column) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  if (!res || !res->current_lengths || column >= res->column_count)
    return 0;

  return static_cast<size_t>(res->current_lengths[column]);

  MDB_GUARD_END(0)
}

int mdb_result_value_is_null(mdb_result_handle result, uint32_t column) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  if (!res || !res->current_row || column >= res->column_count)
    return 1;  /* absent reads as NULL rather than as empty */

  return res->current_row[column] == nullptr ? 1 : 0;

  MDB_GUARD_END(1)
}

const char *mdb_result_column_name(mdb_result_handle result, uint32_t column) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  if (!res || !res->fields || column >= res->column_count)
    return nullptr;

  return res->fields[column].name;

  MDB_GUARD_END(nullptr)
}

uint32_t mdb_result_column_type(mdb_result_handle result, uint32_t column) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  if (!res || !res->fields || column >= res->column_count)
    return 0;

  return static_cast<uint32_t>(res->fields[column].type);

  MDB_GUARD_END(0)
}

uint32_t mdb_result_column_flags(mdb_result_handle result, uint32_t column) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  if (!res || !res->fields || column >= res->column_count)
    return 0;

  /* Carries UNSIGNED_FLAG, BINARY_FLAG, NOT_NULL_FLAG and friends — the
     TypeScript decoder needs these to tell BIGINT from BIGINT UNSIGNED and
     BLOB from TEXT. */
  return static_cast<uint32_t>(res->fields[column].flags);

  MDB_GUARD_END(0)
}

uint32_t mdb_result_column_decimals(mdb_result_handle result, uint32_t column) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  if (!res || !res->fields || column >= res->column_count)
    return 0;

  return static_cast<uint32_t>(res->fields[column].decimals);

  MDB_GUARD_END(0)
}

uint32_t mdb_result_column_charsetnr(mdb_result_handle result, uint32_t column) {
  MDB_GUARD_BEGIN

  mdb::Result *res = mdb::results().get(result);
  if (!res || !res->fields || column >= res->column_count)
    return 0;

  /* charsetnr 63 is binary; it is how BINARY/VARBINARY/BLOB are told apart
     from their text counterparts, which share the same type code. */
  return static_cast<uint32_t>(res->fields[column].charsetnr);

  MDB_GUARD_END(0)
}

void mdb_result_free(mdb_result_handle result) {
  MDB_GUARD_BEGIN

  mdb::results().remove(result).reset();

  MDB_GUARD_END_VOID
}

}  // extern "C"
