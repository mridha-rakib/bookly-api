import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { posix } from "node:path";

/** A release-owned Linux key directory, outside the application source and deployment tree.
 * The privileged key custodian owns every path component. The API's dedicated group may read
 * key files but may not modify them. Registry disposition controls SIGN/VERIFY authorization.
 * This resolver does not create files, provision keys, or qualify a host. */
export function createFileAuditKeyResolver(root: string, readerGroupId: number) {
  const denied = (): never => {
    throw new Error("Protected audit key unavailable");
  };
  if (
    process.platform !== "linux" ||
    !Number.isSafeInteger(readerGroupId) ||
    readerGroupId <= 0 ||
    !root.startsWith("/") ||
    root === "/" ||
    posix.normalize(root) !== root ||
    !/^\/[A-Za-z0-9._/-]+$/.test(root)
  )
    return denied();
  const safeSegment = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  const verifyDirectory = (path: string, restricted = false) => {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      (restricted && (stat.gid !== readerGroupId || (stat.mode & 0o7777) !== 0o750))
    )
      return denied();
    try {
      lstatSync(`${path === "/" ? "" : path}/.git`);
      return denied();
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      )
        return denied();
    }
  };
  return (reference: string, version: string, purpose: "SIGN" | "VERIFY"): Buffer => {
    if (!safeSegment(reference) || !safeSegment(version) || !["SIGN", "VERIFY"].includes(purpose))
      return denied();
    let fd: number | undefined;
    try {
      verifyDirectory("/");
      let path = "";
      for (const part of root.slice(1).split("/")) {
        path += `/${part}`;
        verifyDirectory(path, path === root);
      }
      path += `/${reference}`;
      verifyDirectory(path, true);
      const keyPath = `${path}/${version}.key`;
      const before = lstatSync(keyPath);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.uid !== 0 ||
        before.gid !== readerGroupId ||
        (before.mode & 0o7777) !== 0o640 ||
        before.nlink !== 1 ||
        before.size < 32 ||
        before.size > 64
      )
        return denied();
      fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.uid !== 0 ||
        opened.gid !== readerGroupId ||
        (opened.mode & 0o7777) !== 0o640 ||
        opened.nlink !== 1 ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      )
        return denied();
      const key = readFileSync(fd);
      if (key.length !== opened.size) return denied();
      return key;
    } catch {
      return denied();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
}
