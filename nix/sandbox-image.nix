# The agent sandbox: an OCI image carrying the toolchain `nix develop` gives, plus what a coding
# agent needs to clone, change, test and push June. Nothing in it needs Nix at run time:
#
#   nix build .#sandbox-image && ./result | docker load
#   docker run --rm -it june-sandbox:latest
#
# It runs as the unprivileged `agent` user (uid 1000) in /workspace. Prebuilt npm binaries
# (workerd under wrangler, oxc-parser's native addon) expect a standard Linux loader, which a Nix
# image lacks, so nix-ld stands in at the standard path and finds their libraries through
# NIX_LD_LIBRARY_PATH.
{
  pkgs,
  toolchain,
}:
let
  inherit (pkgs) lib;

  home = "/home/agent";

  # Where a glibc binary built for a regular distro looks for its loader.
  loaderPath =
    {
      x86_64-linux = "lib64/ld-linux-x86-64.so.2";
      aarch64-linux = "lib/ld-linux-aarch64.so.1";
    }
    .${pkgs.stdenv.hostPlatform.system};

  # Shared libraries prebuilt npm binaries link against beyond libc.
  foreignLibs = [
    pkgs.stdenv.cc.cc.lib # libstdc++, libgcc_s
    pkgs.zlib
    pkgs.openssl
  ];

  # Users, groups and name resolution, so tools that look up $USER or resolve hosts work.
  etc = pkgs.runCommand "sandbox-etc" { } ''
    mkdir -p $out/etc
    cat > $out/etc/passwd <<EOF
    root:x:0:0:root:/root:/bin/bash
    agent:x:1000:1000:agent:${home}:/bin/bash
    nobody:x:65534:65534:nobody:/var/empty:/bin/false
    EOF
    cat > $out/etc/group <<EOF
    root:x:0:
    agent:x:1000:
    nogroup:x:65534:
    EOF
    echo 'hosts: files dns' > $out/etc/nsswitch.conf
  '';
in
pkgs.dockerTools.streamLayeredImage {
  name = "june-sandbox";
  tag = "latest";

  contents =
    toolchain
    ++ (with pkgs; [
      bashInteractive
      coreutils
      findutils
      diffutils
      gnugrep
      gnused
      gawk
      gnutar
      gzip
      unzip
      which
      procps
      less
      curl
      gitMinimal # git without the Perl/Python extras: 162 MiB closure instead of 389
      gh
      openssh
      ripgrep
      fd
      tmux # scripts/agent-sandbox.sh keeps each agent in a session you can detach from
      python3Minimal # scripts/smoke-packed.sh edits package.json with it
    ])
    ++ [
      etc
      pkgs.dockerTools.binSh
      pkgs.dockerTools.usrBinEnv
      pkgs.dockerTools.caCertificates
    ];

  fakeRootCommands = ''
    mkdir -p tmp ${lib.removePrefix "/" home} workspace $(dirname ${loaderPath})
    chmod 1777 tmp
    chown -R 1000:1000 ${lib.removePrefix "/" home} workspace
    ln -s ${pkgs.nix-ld}/libexec/nix-ld ${loaderPath}
  '';

  config = {
    # The source label links the published ghcr.io package to the repository (and its access
    # permissions). No revision label: it would change the image on every commit.
    Labels = {
      "org.opencontainers.image.source" = "https://github.com/junebuild/june";
      "org.opencontainers.image.description" = "June agent sandbox: the pinned Bun, Node 24 and dev tools";
      "org.opencontainers.image.licenses" = "MIT";
    };
    User = "agent";
    WorkingDir = "/workspace";
    Cmd = [ "bash" ];
    Env = [
      "HOME=${home}"
      "USER=agent"
      "LANG=C.UTF-8"
      "PATH=/bin:/usr/bin"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "NIX_LD=${pkgs.stdenv.cc.bintools.dynamicLinker}"
      "NIX_LD_LIBRARY_PATH=${lib.makeLibraryPath foreignLibs}"
    ];
  };
}
