import { writeFile } from 'node:fs/promises'
import { ConflictError } from '../errors.ts'

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

export interface Release {
  tag_name: string
  name: string
  assets: ReleaseAsset[]
}

export function releaseVersion(release: Release): string {
  return release.tag_name.replace(/^v/, '')
}

export async function latestRelease(repo: string): Promise<Release> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'bita-cli' },
  })
  if (!response.ok) {
    throw new ConflictError(
      `GitHub answered ${response.status} asking for the latest release of ${repo}.`,
      'RELEASE_UNREACHABLE',
      'Check the network, or download it by hand from the releases page.',
    )
  }
  return (await response.json()) as Release
}

export async function downloadAsset(asset: ReleaseAsset, destination: string): Promise<void> {
  const response = await fetch(asset.browser_download_url, { redirect: 'follow' })
  if (!response.ok) {
    throw new ConflictError(
      `The download answered ${response.status}.`,
      'DOWNLOAD_FAILED',
      'Try again, or download it by hand from the releases page.',
    )
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}
