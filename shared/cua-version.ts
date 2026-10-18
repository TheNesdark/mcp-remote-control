/**
 * Single source of truth for the shipped Cua Driver build (trycua/cua, MIT).
 *
 * The Dockerfile downloads exactly this version's official Windows zip and
 * fails the build if the checksum does not match; agents auto-provision it
 * from the hub and verify the same sha256. Bumping the driver means bumping
 * these three constants — server and agents can never drift.
 *
 * Regenerate shared/cua-tools-manifest.json with `bun run gen:cua-manifest`
 * (fetches the tool schemas from the driver's `dump-docs`) after bumping.
 */
export const CUA_DRIVER_VERSION = "0.36.0";

/** sha256 of cua-driver-rs-0.36.0-windows-x86_64-binary.zip (from checksums.txt). */
export const CUA_DRIVER_SHA256 = "f8c47024b626f4e0e70f8428d2998df39e4879110c5722a29d5fd03e367353ad";

/** Path on the hub where the zip is served (like /agent/latest.exe). */
export const CUA_DRIVER_URL_PATH = "/cua/latest.zip";
