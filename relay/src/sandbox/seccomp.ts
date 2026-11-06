/**
 * The Linux sandbox's local-socket filter: a classic BPF program that
 * bubblewrap loads with `--seccomp` before it runs the confined command.
 *
 * WHY A FILTER AND NOT JUST HIDDEN FOLDERS. A program can open a Unix
 * socket on any path it can see, even on a read-only mount, and the
 * session bus behind such a socket starts unconfined programs on request
 * (`systemd-run --user`). Hiding /run with an empty folder was beaten in
 * testing by a worktree chosen under /run/user, and a podman socket sat in
 * the home folder, which a run must be able to read. Refusing socket(AF_UNIX)
 * closes the whole class however the path is reached. The run never needs
 * one: its single route out is pasta's loopback forwarding to Relay's
 * proxy, and socketpair(), which toolchains use for child processes, is a
 * different system call and stays allowed.
 *
 * What the program does, in order:
 *   - a call made through another architecture's table (32-bit compat, or
 *     x32 on x86_64) kills the process, since its system call numbers mean
 *     something else and would slip past every check below;
 *   - io_uring_setup is refused, since io_uring can open sockets without
 *     the socket() system call this filter watches;
 *   - socket() with domain AF_UNIX is refused with EPERM;
 *   - everything else is allowed.
 *
 * Only the low 32 bits of socket()'s domain argument are compared, which
 * is what the kernel itself reads (the argument is an int), so high bits
 * cannot dress AF_UNIX up as something else.
 */

/** seccomp_data offsets (linux/seccomp.h): nr, arch, then args[] from byte 16. */
const OFFSET_NR = 0
const OFFSET_ARCH = 4
const OFFSET_ARG0_LOW = 16

const BPF_LD_W_ABS = 0x20
const BPF_JMP_JEQ_K = 0x15
const BPF_JMP_JGE_K = 0x35
const BPF_RET_K = 0x06

const SECCOMP_RET_ALLOW = 0x7fff0000
const SECCOMP_RET_KILL_PROCESS = 0x80000000
const SECCOMP_RET_ERRNO_EPERM = 0x00050000 | 1

const AF_UNIX = 1
/** x32 system calls on x86_64 carry this bit in their number. */
const X32_SYSCALL_BIT = 0x40000000

type ArchTable = {
  readonly auditArch: number
  readonly socket: number
  readonly ioUringSetup: number
  /** x86_64 only: x32 calls share the arch value, so they are told apart by number. */
  readonly rejectX32: boolean
}

/** Keyed by `process.arch`. Numbers from each architecture's unistd table; io_uring_setup is 425 on both. */
const ARCHES: Readonly<Record<string, ArchTable>> = {
  x64: { auditArch: 0xc000003e, socket: 41, ioUringSetup: 425, rejectX32: true },
  arm64: { auditArch: 0xc00000b7, socket: 198, ioUringSetup: 425, rejectX32: false },
}

type Label = 'allow' | 'deny' | 'kill'
/** One instruction; a jump names its targets by label, or `next` to fall through. */
type Instruction =
  | { readonly op: 'load'; readonly offset: number }
  | { readonly op: 'jeq' | 'jge'; readonly value: number; readonly ifTrue: Label | 'next'; readonly ifFalse: Label | 'next' }
  | { readonly op: 'ret'; readonly label: Label; readonly value: number }

function program(arch: ArchTable): Instruction[] {
  return [
    { op: 'load', offset: OFFSET_ARCH },
    { op: 'jeq', value: arch.auditArch, ifTrue: 'next', ifFalse: 'kill' },
    { op: 'load', offset: OFFSET_NR },
    ...(arch.rejectX32 ? [{ op: 'jge', value: X32_SYSCALL_BIT, ifTrue: 'kill', ifFalse: 'next' } as const] : []),
    { op: 'jeq', value: arch.ioUringSetup, ifTrue: 'deny', ifFalse: 'next' },
    { op: 'jeq', value: arch.socket, ifTrue: 'next', ifFalse: 'allow' },
    { op: 'load', offset: OFFSET_ARG0_LOW },
    { op: 'jeq', value: AF_UNIX, ifTrue: 'deny', ifFalse: 'allow' },
    { op: 'ret', label: 'allow', value: SECCOMP_RET_ALLOW },
    { op: 'ret', label: 'deny', value: SECCOMP_RET_ERRNO_EPERM },
    { op: 'ret', label: 'kill', value: SECCOMP_RET_KILL_PROCESS },
  ]
}

/** Encodes struct sock_filter entries (u16 code, u8 jt, u8 jf, u32 k), resolving labels to forward offsets. */
function assemble(instructions: readonly Instruction[]): Buffer {
  const labelIndex = new Map<Label, number>()
  instructions.forEach((instruction, index) => {
    if (instruction.op === 'ret') labelIndex.set(instruction.label, index)
  })
  const offset = (from: number, target: Label | 'next'): number => {
    if (target === 'next') return 0
    const to = labelIndex.get(target)
    if (to === undefined || to <= from) throw new Error(`seccomp program: label ${target} must follow instruction ${from}`)
    return to - from - 1
  }

  const buffer = Buffer.alloc(instructions.length * 8)
  instructions.forEach((instruction, index) => {
    const at = index * 8
    if (instruction.op === 'load') {
      buffer.writeUInt16LE(BPF_LD_W_ABS, at)
      buffer.writeUInt32LE(instruction.offset, at + 4)
    } else if (instruction.op === 'ret') {
      buffer.writeUInt16LE(BPF_RET_K, at)
      buffer.writeUInt32LE(instruction.value >>> 0, at + 4)
    } else {
      buffer.writeUInt16LE(instruction.op === 'jeq' ? BPF_JMP_JEQ_K : BPF_JMP_JGE_K, at)
      buffer.writeUInt8(offset(index, instruction.ifTrue), at + 2)
      buffer.writeUInt8(offset(index, instruction.ifFalse), at + 3)
      buffer.writeUInt32LE(instruction.value >>> 0, at + 4)
    }
  })
  return buffer
}

/** The filter for `arch` (a `process.arch` value), or undefined when this sandbox has no table for it. */
export function unixSocketFilter(arch: string = process.arch): Buffer | undefined {
  const table = ARCHES[arch]
  return table === undefined ? undefined : assemble(program(table))
}

/** The architectures the filter supports, for the refusal message on any other. */
export const SUPPORTED_FILTER_ARCHES: readonly string[] = Object.keys(ARCHES)
