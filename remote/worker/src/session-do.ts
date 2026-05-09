import type { SessionState, Env } from "./types.js";
import { getSandbox } from "@cloudflare/sandbox";

export class SessionDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith("/setup") && request.method === "POST") {
      return this.handleSetup(request);
    }

    if (path.endsWith("/verify") && request.method === "GET") {
      return this.handleVerify();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleSetup(request: Request): Promise<Response> {
    const body = await request.json() as {
      owner: string;
      name: string;
      githubToken: string;
      userId: string;
    };

    const { owner, name, githubToken, userId } = body;
    const sessionId = crypto.randomUUID();
    const githubUrl = `https://github.com/${owner}/${name}.git`;

    try {
      // 1. Import repo into Artifacts
      const artifact = await this.env.ARTIFACTS.import({
        source: { url: githubUrl, branch: "main" },
        target: { name: sessionId },
      });

      // 2. Create a write token for the artifact
      const tokenRes = await this.env.ARTIFACTS.get(sessionId).createToken("read-write", 3600);
      const artifactToken = tokenRes.plaintext;

      // 3. Get a sandbox instance
      const sandbox = await getSandbox(this.env.SANDBOX, sessionId);

      // 4. Clone the artifact repo into the sandbox
      const encodedToken = encodeURIComponent(artifactToken);
      const authArtifactUrl = artifact.remote.replace("https://", `https://token:${encodedToken}@`);
      const cloneRes = await sandbox.exec(`git clone ${authArtifactUrl} /workspace/repo`);
      if (!cloneRes.success) {
        throw new Error(`git clone failed: ${cloneRes.stderr || cloneRes.stdout}`);
      }

      // 5. Run git log to prove it worked
      const logRes = await sandbox.exec("cd /workspace/repo && git log --oneline -5");
      if (!logRes.success) {
        throw new Error(`git log failed: ${logRes.stderr || logRes.stdout}`);
      }

      // 6. Store minimal session state
      const sessionState: SessionState = {
        sessionId,
        userId,
        repo: { owner, name },
        artifactsRepo: {
          name: sessionId,
          url: artifact.remote,
          writeToken: artifactToken,
        },
        createdAt: Date.now(),
      };
      await this.state.storage.put("state", sessionState);

      return Response.json({ success: true, output: logRes.stdout, sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ success: false, error: message }, { status: 500 });
    }
  }

  private async handleVerify(): Promise<Response> {
    const state = await this.state.storage.get<SessionState>("state");
    if (!state) {
      return new Response("Not found", { status: 404 });
    }
    return Response.json({ userId: state.userId, sessionId: state.sessionId });
  }
}
