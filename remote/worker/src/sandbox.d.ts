declare module "@cloudflare/sandbox" {
  export interface SandboxInstance {
    id: string;
    exec(command: string, opts?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin?: string;
      timeout?: number;
    }): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      success: boolean;
    }>;
    execStream(command: string, opts?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin?: string;
      timeout?: number;
    }): Promise<ReadableStream>;
    writeFile(path: string, content: string): Promise<void>;
    readFile(path: string): Promise<string>;
    setKeepAlive(keepAlive: boolean): Promise<void>;
    destroy(): Promise<void>;
    terminal(request: Request, options?: { cols?: number; rows?: number }): Promise<Response>;
  }

  export function getSandbox(
    namespace: DurableObjectNamespace,
    name: string,
    options?: { keepAlive?: boolean }
  ): SandboxInstance;
}
