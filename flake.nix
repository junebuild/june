{
  # Optional: `bun install && bun run ci` with your own Bun and Node 24 stays the supported path.
  # This flake pins that same toolchain for maintainers, agent sandboxes and one CI lane, so a
  # result from any of them means the same thing.
  description = "June development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      # Bun's version has ONE source, package.json's packageManager (CI's setup-bun reads it
      # too). nix/bun.json carries the release hashes for that version; scripts/bump-bun.ts
      # rewrites both.
      bunVersion = lib.removePrefix "bun@" (lib.importJSON ./package.json).packageManager;
      bunPin = lib.importJSON ./nix/bun.json;

      # Nix system → Bun release asset. No x86_64-darwin: nixpkgs-unstable dropped it (26.11).
      assets = {
        aarch64-darwin = "bun-darwin-aarch64";
        aarch64-linux = "bun-linux-aarch64";
        x86_64-linux = "bun-linux-x64-baseline";
      };

      forAllSystems = f: lib.genAttrs (lib.attrNames assets) (system: f nixpkgs.legacyPackages.${system});

      # nixpkgs' bun derivation (it patches the binary for Nix), fed Bun's official release
      # asset for OUR version, so the repo never waits on nixpkgs to bump Bun.
      bunFor =
        pkgs:
        assert lib.assertMsg (bunPin.version == bunVersion)
          "nix/bun.json is for Bun ${bunPin.version}, but package.json wants ${bunVersion}: run `bun scripts/bump-bun.ts ${bunVersion}`";
        let
          sources = lib.mapAttrs (
            system: asset:
            pkgs.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${asset}.zip";
              hash = bunPin.hashes.${system};
            }
          ) assets;
        in
        pkgs.bun.overrideAttrs (prev: {
          version = bunVersion;
          src = sources.${pkgs.stdenv.hostPlatform.system};
          passthru = prev.passthru // {
            inherit sources;
          };
        });

      # The one toolchain: the devShell and the agent sandbox image both carry exactly this.
      toolchainFor = pkgs: [
        (bunFor pkgs)
        pkgs.nodejs_24 # the Node-host and packed-tarball smokes; tsdown needs Node ≥ 22.18
        pkgs.jq
      ];
    in
    {
      packages = forAllSystems (
        pkgs:
        {
          bun = bunFor pkgs;
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          sandbox-image = import ./nix/sandbox-image.nix {
            inherit pkgs;
            toolchain = toolchainFor pkgs;
          };
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = toolchainFor pkgs;
        };
      });

      checks = forAllSystems (
        pkgs:
        let
          bun = bunFor pkgs;
        in
        {
          # The pinned binary runs and reports the version package.json asks for.
          bun-version = pkgs.runCommand "bun-version" { } ''
            actual=$(${lib.getExe bun} --version)
            if [ "$actual" != "${bunVersion}" ]; then
              echo "bun --version is $actual, package.json wants ${bunVersion}" >&2
              exit 1
            fi
            touch $out
          '';
          devShell = self.devShells.${pkgs.stdenv.hostPlatform.system}.default;
        }
      );
    };
}
