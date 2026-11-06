/** Drive versions include metadata changes and are not a content compare-and-swap.
 * Callers hold their cooperative writer lock and verify ownership on every metadata read. */
import { AdapterError } from './index.js';
export function createPrivateCheckpoint<T>(ports: {
  version(): string; read(): unknown; write(value: T): void;
  validate(value: unknown): T; digest(value: unknown): string;
}) {
  let expectedDigest: string | undefined;
  const fail = (message: string): never => { throw new AdapterError('private_checkpoint_changed', message); };
  function readStable(): T {
    const before = ports.version(), value = ports.validate(ports.read()), after = ports.version();
    if (before !== after) {
      // Drive may advance metadata after a successful media update. Require a second
      // identical content read; a changed payload is never accepted as metadata drift.
      const repeated = ports.validate(ports.read());
      if (ports.digest(repeated) !== ports.digest(value)) fail('Private checkpoint content changed while being read.');
    }
    return value;
  }
  return {
    load(): T { const value = readStable(); expectedDigest = ports.digest(value); return value; },
    save(value: T): void {
      ports.validate(value);
      if (expectedDigest === undefined) fail('Read the private checkpoint before saving it.');
      if (ports.digest(readStable()) !== expectedDigest) fail('Private checkpoint content changed outside this operation.');
      ports.write(value);
      const reread = readStable();
      if (ports.digest(reread) !== ports.digest(value)) fail('Private checkpoint readback does not match the saved content.');
      expectedDigest = ports.digest(reread);
    },
  };
}
