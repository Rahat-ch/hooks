/**
 * Formatting filesystems and writing to raw block devices: always blocked.
 */
import { parseOptions, type SimpleCommand } from "../../shell";
import type { Finding } from "../guard";

/**
 * Block devices and raw memory: Linux disks, partitions, NVMe, MMC, RAID,
 * device-mapper and loop devices; macOS `disk`/`rdisk`; BSD/Solaris disks;
 * Windows `\\.\PhysicalDrive0` and `\\.\C:`. Not `/dev/null`, `/dev/zero`,
 * ttys or `/dev/fd/*`.
 */
const DEVICE =
  /^(\/dev\/(sd[a-z]+\d*|hd[a-z]+\d*|vd[a-z]+\d*|xvd[a-z]+\d*|nvme\d+(n\d+(p\d+)?)?|r?disk\d+(s\d+)*|mmcblk\d+(p\d+)?|md\d+|dm-\d+|mapper\/.+|loop\d+|nbd\d+|zd\d+|(r?dsk|disk\/by-[a-z]+)\/.+|ada\d+.*|da\d+.*|mem|kmem|port)|\\\\[.?]\\(physicaldrive\d+|[a-z]:|harddisk\d+.*))$/i;

export const isDevice = (path: string) => DEVICE.test(path);

/** Programs that create a filesystem or wipe signatures. */
function formatsDisk(command: SimpleCommand): boolean {
  const p = command.program;
  if (p === "mkfs" || p.startsWith("mkfs.") || p.startsWith("newfs")) return true;
  if (["mke2fs", "mkswap", "wipefs", "mkntfs", "mkdosfs", "mkexfatfs", "mformat"].includes(p)) return true;
  if (p === "diskutil") {
    const [verb = "", sub = ""] = command.argv
      .slice(1)
      .filter((arg) => !arg.startsWith("-"))
      .map((arg) => arg.toLowerCase());
    return (
      ["erasedisk", "erasevolume", "reformat", "partitiondisk", "zerodisk", "randomdisk", "secureerase"].includes(verb) ||
      (verb === "apfs" && ["deletecontainer", "erasevolume", "deletevolume"].includes(sub))
    );
  }
  return false;
}

/** Device paths a command writes to through its arguments. */
function deviceOperands(command: SimpleCommand): string[] {
  const args = command.argv.slice(1);
  switch (command.program) {
    case "dd":
      return args.flatMap((arg) => (arg.startsWith("of=") ? [arg.slice(3)] : []));
    case "tee":
    case "shred":
      return [...parseOptions(args).operands];
    case "cp":
    case "mv":
    case "install": {
      const parsed = parseOptions(args, { withValue: ["-t", "--target-directory", "-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"] });
      const target = parsed.options.find((o) => o.name === "-t" || o.name === "--target-directory")?.value;
      return target !== undefined ? [target] : parsed.operands.slice(-1);
    }
    default:
      return [];
  }
}

export function deviceFindings(command: SimpleCommand): Finding[] {
  if (!command.executes) return [];
  const findings: Finding[] = [];
  if (formatsDisk(command)) {
    findings.push({
      decision: "block",
      reason: `\`${command.argv.join(" ")}\` formats or erases a disk, destroying everything on it. Ask the user to do this themselves.`,
    });
  }
  const written = [
    ...deviceOperands(command),
    // As written too: on Windows `/dev/sda` resolves to `C:\dev\sda`, but Git Bash opens the raw disk.
    ...command.redirections.filter((r) => r.direction !== "read").flatMap((r) => [r.target, r.path ?? r.target]),
  ].filter(isDevice);
  for (const device of new Set(written)) {
    findings.push({
      decision: "block",
      reason: `This writes directly to the raw device ${device}, which can destroy its partitions and data. Ask the user to do this themselves.`,
    });
  }
  return findings;
}
