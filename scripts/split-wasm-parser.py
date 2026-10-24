#!/usr/bin/env python3
"""Bound V8 compilation memory by splitting Bison's semantic-action switch.

MariaDB 11.4's ~3,800-rule MYSQLparse needs about 1 GiB to optimize in V8.
Keep the parser state machine intact and move groups of unchanged actions into
noinline lambdas. Return abort/error signals to the original parser labels so
Bison retains ownership of cleanup and error recovery. Applied only to WASM.
"""
import pathlib
import re
import sys

MARKER = "/* WASM: bounded semantic-action functions. */"


def split_parser(source):
    if MARKER in source:
        return source
    start = source.index("  switch (yyn)\n    {", source.index("\nyyreduce:"))
    end = source.index("      default: break;\n    }", start)
    stop = end + len("      default: break;\n    }")
    actions = source[start + len("  switch (yyn)\n    {"):end]
    matches = list(re.finditer(r"^  case (\d+):", actions, re.MULTILINE))
    if len(matches) < 1000:
        raise ValueError("unexpected Bison action table; refusing to transform")
    groups = {}
    for index, match in enumerate(matches):
        limit = matches[index + 1].start() if index + 1 < len(matches) else len(actions)
        groups.setdefault(int(match[1]) // 128, []).append(actions[match.start():limit])
    chunks = [MARKER, """  {
#pragma push_macro("YYABORT")
#pragma push_macro("YYERROR")
#undef YYABORT
#undef YYERROR
#define YYABORT return 1
#define YYERROR return 2
    int action_status = 0;
    switch (yyn / 128) {
"""]
    for group, cases in groups.items():
        chunks.append(f"    case {group}:\n      action_status = [&]() __attribute__((noinline)) -> int {{\n        switch (yyn) {{\n")
        chunks.extend(cases)
        chunks.append("        default: break;\n        }\n        return 0;\n      }();\n      break;\n")
    chunks.append("""    }
#pragma pop_macro("YYERROR")
#pragma pop_macro("YYABORT")
    if (action_status == 1) YYABORT;
    if (action_status == 2) YYERROR;
  }
""")
    return source[:start] + "".join(chunks) + source[stop:]


if __name__ == "__main__":
    for name in sys.argv[1:]:
        path = pathlib.Path(name)
        source = path.read_text()
        output = split_parser(source)
        if output != source:
            path.write_text(output)
            print(f"split semantic actions: {path.name}")
