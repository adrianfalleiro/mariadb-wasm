"""Check the parser rewrite's action dispatch, references, and control transfers."""
import importlib.util
import pathlib
import subprocess
import tempfile
import sys
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    "split_parser", pathlib.Path(__file__).with_name("split-wasm-parser.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture():
    cases = []
    for rule in range(1, 1025):
        cases.append(f"  case {rule}: yyval += {rule}; break;\n")
    cases.extend([
        "  case 1025: yyval += yyvsp[0]; yychar = 7; YYABORT;\n",
        "  case 1026: yyval += yyvsp[0]; yychar = 8; YYERROR;\n",
    ])
    return """
#define YYABORT goto yyabortlab
#define YYERROR goto yyerrorlab
int parse(int yyn, int &yyval, int &yychar, int *yyvsp) {
yyreduce:
  switch (yyn)
    {
""" + "".join(cases) + """      default: break;
    }
  return 0;
yyabortlab:
  yyval += 10000; return 1;
yyerrorlab:
  yyval += 20000; return 2;
}
"""


class SplitParserTest(unittest.TestCase):
    def test_idempotent(self):
        output = module.split_parser(fixture())
        self.assertIn(module.MARKER, output)
        self.assertEqual(output.count("__attribute__((noinline))"), 9)
        self.assertEqual(module.split_parser(output), output)

    def test_unexpected_skeleton_fails_closed(self):
        with self.assertRaises(ValueError):
            module.split_parser("int main() {}")
        with self.assertRaises(ValueError):
            module.split_parser(fixture().replace("  case ", "  /* case */ "))

    def test_every_action_and_parser_cleanup_are_preserved(self):
        main = """
int main() {
  int input = 3;
  for (int rule = 1; rule <= 1024; ++rule) {
    int value = 11, lookahead = 2;
    if (parse(rule, value, lookahead, &input) != 0 ||
        value != 11 + rule || lookahead != 2) return 1;
  }
  int value = 11, lookahead = 2;
  if (parse(0, value, lookahead, &input) != 0 || value != 11) return 2;
  if (parse(1025, value, lookahead, &input) != 1 ||
      value != 10014 || lookahead != 7) return 3;
  value = 11;
  if (parse(1026, value, lookahead, &input) != 2 ||
      value != 20014 || lookahead != 8) return 4;
  return 0;
}
"""
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "parser.cc"
            binary = pathlib.Path(directory) / "parser"
            for code in (fixture(), module.split_parser(fixture())):
                source.write_text(code + main)
                subprocess.run(["c++", "-std=c++17", "-O2", str(source), "-o", str(binary)], check=True)
                subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
