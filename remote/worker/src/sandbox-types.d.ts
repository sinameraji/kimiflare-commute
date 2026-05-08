declare module "@cloudflare/sandbox" {
  export class Sandbox<Env = unknown> extends DurableObject<Env> {}
}

declare module "@cloudflare/sandbox/bridge" {
  export class WarmPool extends DurableObject {}
}
