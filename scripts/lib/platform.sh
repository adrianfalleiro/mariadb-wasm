# Sourced by the build scripts. Everything host-specific lives here so the
# scripts themselves read the same on macOS and Linux.
#
# Every value can be overridden from the environment, which is what makes an
# unusual toolchain layout someone else's problem to configure rather than a
# patch to these scripts.

# c++ rather than clang++: it is clang++ on macOS and g++ on most Linux
# distributions, and CI images are not obliged to ship clang.
export HOST_CXX="${HOST_CXX:-c++}"

case "$(uname -s)" in
  Darwin)
    # Homebrew bison. macOS ships 2.3, which cannot build the SQL parser.
    if [ -d /opt/homebrew/opt/bison/bin ]; then
      export PATH="/opt/homebrew/opt/bison/bin:$PATH"
    elif [ -d /usr/local/opt/bison/bin ]; then
      export PATH="/usr/local/opt/bison/bin:$PATH"
    fi

    # The SDK path has to be pinned explicitly; see 02-build-host-tools.sh for
    # the header-precedence problem this avoids.
    HOST_CMAKE_ARGS=(-DCMAKE_OSX_SYSROOT="$(xcrun --show-sdk-path)")

    # libiconv is a separate library on macOS. On glibc it is part of libc and
    # -liconv fails to link.
    HOST_LINK_LIBS=(-lresolv -liconv)
    ;;
  *)
    HOST_CMAKE_ARGS=()
    HOST_LINK_LIBS=(-lresolv -ldl)
    ;;
esac

export HOST_CMAKE_ARGS HOST_LINK_LIBS

# Fail early and clearly rather than partway through a long build.
require_bison_3() {
  local version
  version="$(bison --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)"
  case "$version" in
    "") echo "bison not found; install bison 3.x" >&2; return 1 ;;
    3.*|[4-9].*) ;;
    *) echo "bison $version is too old for the SQL parser; install 3.x" >&2
       return 1 ;;
  esac
}
