# Publishing checklist

Everything in the repository is ready to commit; this file lists what **you** still have to
fill in, and the exact commands. Delete it (or keep it as a maintainer note) once published.

## 1. Replace the placeholders

`OWNER` appears three times in `package.json`:

```text
repository.url   git+https://github.com/OWNER/dsh-audio-toolkit.git
homepage         https://github.com/OWNER/dsh-audio-toolkit#readme
bugs.url         https://github.com/OWNER/dsh-audio-toolkit/issues
```

Replace it with your GitHub account/org, then update the install examples in
`README.md` (`dsh-audio-toolkit@0.7.0`) once the package is actually published.

Optional: `LICENSE` says “dsh-audio-toolkit contributors”; put your name there if you prefer.

## 2. Verify nothing private is committed

```bash
git init
git add .
git status --short
```

The listing must **not** contain `bin/`, `models/`, `audio_samples/`, `voices/`,
`state/`, `out/`, `audio_toolkit_outputs/`, `audio.cpp/`, or `node_modules/`.
They are all in `.gitignore`; if one shows up, fix `.gitignore` before committing.

Quick sanity check for personal paths (should print nothing):

```bash
grep -rn "C:\\\\Users" --include="*.md" --include="*.json" --include="*.yml" .
```

## 3. Commit and push

```bash
git commit -m "dsh-audio-toolkit 0.7.0"
git branch -M main
git remote add origin https://github.com/OWNER/dsh-audio-toolkit.git
git push -u origin main
git tag v0.7.0 && git push origin v0.7.0
```

Create a GitHub release from the tag and paste the relevant `CHANGELOG.md` section.

## 4. Publish to npm (optional but recommended)

```bash
npm pack --dry-run   # confirm LICENSE/docs are included, test/ and state/ are not
npm publish --access public
```

The package name `dsh-audio-toolkit` must be available (check `npm view dsh-audio-toolkit`).
After publishing, DSH installs it with:

```text
plugin_manager(action="install_bundle", target="dsh-audio-toolkit@0.7.0")
```

## 5. About `github:` install specs

`package.json` is at the repository root, so DSH can install straight from GitHub:

```text
plugin_manager(action="install_bundle", target="github:OWNER/dsh-audio-toolkit#v0.7.0")
```

npm publishing (§4) is still recommended for version pinning and update discovery.

## 6. Before every release

```bash
npm test                 # syntax + unit tests + contract check
npm run test:smoke       # only on a machine with the release, models and a GPU
npm run docs:contract    # if tools/parameters changed
```

Bump the version in `package.json` (single place) and add a `CHANGELOG.md` entry.
