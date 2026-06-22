import { encodeReply } from "react-server-dom-webpack/client";
export async function encode(args: unknown[]): Promise<string | FormData> {
  return encodeReply(args);
}
