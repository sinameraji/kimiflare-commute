declare module "@cloudflare/sandbox" {
  export class Sandbox<Env = unknown> extends DurableObject<Env> {}
}
