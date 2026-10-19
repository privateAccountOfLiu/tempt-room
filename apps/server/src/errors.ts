/** The execution outcome could not be proven; the caller must not retry blindly. */
export class ExecutionUnknown extends Error {}
/** A remote or native agent confirmed cancellation. */
export class RemoteCanceled extends Error {}
