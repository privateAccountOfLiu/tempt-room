export const IMAGE_CHUNK_BYTES: number;
export const IMAGE_MAX_BYTES: number;
export interface RoomImageFile { bytes: Buffer; name: string; sha256: string; size: number }
export function imageRoots(env?: Record<string, string | undefined>, cwd?: string): string[];
export function readLocalImage(file: string, roots: string[], maxBytes?: number): RoomImageFile;
export function uploadImage(call: (name: string, args: Record<string, unknown>, commandId: string) => Promise<any>, bytes: Buffer, options: {name: string; operationId: string; alt?: string}): Promise<any>;
export function sendImage(call: (name: string, args: Record<string, unknown>, commandId: string) => Promise<any>, bytes: Buffer, options: {name: string; operationId: string; text?: string; alt?: string; mentions?: string[]; replyTo?: string}): Promise<any>;
export function roomSendImage(call: (name: string, args: Record<string, unknown>, commandId: string) => Promise<any>, args: Record<string, any>, roots: string[]): Promise<any>;
export const roomSendImageTool: any;
