import { readFileSync } from 'node:fs';

interface ProjectIdentity {
  readonly name: string;
  readonly version: string;
}

interface ProjectLockIdentity extends ProjectIdentity {
  readonly packages: { readonly '': ProjectIdentity };
}

const packageMetadata = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as ProjectIdentity;
export const projectIdentity: ProjectIdentity = {
  name: packageMetadata.name,
  version: packageMetadata.version,
};

export const projectLockIdentity = JSON.parse(
  readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'),
) as ProjectLockIdentity;
