# Using RepoMind

RepoMind reads a code project and helps you find your way around it. You can browse the files, search for functions, see how the parts fit together, and ask questions in plain English. Every answer points to the exact files and lines it used, and says so when the project doesn't contain the answer. RepoMind never changes, pushes or runs your code.

Address: <https://repomind.repomind.workers.dev>

## 1. Get an invitation

RepoMind is invite-only. Ask the person who runs it for an invitation code. It starts with `rmi_`, works **once**, and expires after a few days (7 by default).

An invitation gives you access to RepoMind with your own, empty, private account. It does not give you access to anyone else's repositories, and nobody else can see yours.

## 2. Create your account and save your sign-in key

1. Open RepoMind, paste the invitation code into **Invitation code or sign-in key**, and choose **Continue**.
2. RepoMind creates your account and shows your personal **sign-in key**, which starts with `rmk_`. **This is the only time it is shown.** RepoMind keeps only a fingerprint of it.
3. Save the key somewhere safe: **Copy key** into a password manager, or **Download as a text file** and store that file securely. Treat it like a password and don't share it.
4. Tick **I have saved my sign-in key somewhere safe**, then **Continue to RepoMind**.

## 3. Sign in again

Paste your sign-in key into the same field and choose **Continue**. Sessions last 7 days; after that, or after **Sign out**, paste the key again.

**Lost your key?** Ask the person who invited you for a recovery code. Entering it gives you a new key, signs out your other devices and keeps your repositories.

## 4. Your allowance

The dashboard shows how many of your **5 repositories** you are using, for example "3 of 5 repositories used". Each account can also start **20 indexing jobs** and ask **100 questions** a day, at most 6 a minute. Delete a repository you no longer need to free a slot.

## 5. Add a public GitHub repository

1. Under **Public GitHub repository**, paste a URL such as `https://github.com/expressjs/cors`, or a branch URL ending in `/tree/<branch>`.
2. Choose **Index repository**. RepoMind pins the latest commit and starts indexing.

Limits:
- **Too many files:** repositories with more than 2,000 supported files are refused.
- **Too much text:** a larger repository is indexed **partially**, README, manifests and source first, and RepoMind lists what was left out. One that needs more than four times the limit is refused.
- **Large files:** files over 400 KB are skipped.

## 6. Upload a ZIP

Use **ZIP upload** → **Choose a ZIP file** for a private project or any code that isn't a public GitHub repository. On GitHub, **Code → Download ZIP** gives you one.

How it works:
- **Read in your browser.** Your browser reads the ZIP, and only supported source and documentation files are sent, a few at a time. Nothing in it is ever run.
- **Limits:** 50 MB, 20,000 entries and 2,000 supported files.
- **Refused:** encrypted, ZIP64 and split archives.
- **Skipped:** symbolic links, dependencies, build output, lockfiles, binaries and files that commonly hold credentials.
- **Keep the tab open** while files upload. If the upload is interrupted, open the repository and choose the same ZIP again to resume. An upload with no progress for 24 hours is stopped.
- **New versions.** To update the project later, open it and choose **Upload a new version**.

Before uploading, read [what not to upload](security-and-privacy.md#what-not-to-upload).

## 7. While it is indexed

The badge on each repository shows its state:

| Badge | Meaning |
|---|---|
| **Indexing** / **Uploading** | Files are being read. Real file counts are shown. |
| **Paused** | GitHub limited or failed some downloads. It resumes by itself at the time shown. |
| **Search ready** | Files, search, symbols and the architecture summary work now. The semantic index, which helps Ask match questions by meaning, is still building or paused; until then answers use keyword evidence. |
| **Ready** | Everything is available. |
| **Partial index** | Some supported files did not fit. They are never searched or cited. |
| **Failed** / **Cancelled** | The reason is shown on the Overview tab. Re-index (or upload again), or delete the repository. |

Indexing continues in the background if you close the page.

## 8. Explore a repository

Open a repository from the dashboard. The tabs are:

- **Overview:** the index status, an **architecture summary** (purpose, languages, entry points, dependencies, main folders; each statement links to its lines), and what was indexed or skipped. The **Manage** section is here too.
- **Files:**
  - Filter and open any indexed file, shown with line numbers exactly as indexed.
  - Code files also show their **Outline** (functions and classes), the files they **Import**, and the files that import them (**Imported by**). Each entry links to its lines.
- **Search:**
  - **A function, class or variable name**, such as `handleLogin`, shows where it is **defined**, then every place it is **used**.
  - **A few words**, such as `rate limit`, find passages that contain all of them. Word beginnings match too: `auth` finds `authenticate`.
  - Search is exact. To ask by meaning, use Ask.
- **Ask:**
  - Ask in plain English. Specific questions work best: name a feature, a file or a function, as in "How are passwords checked?" or "What calls `saveUser`?".
  - **Citations.** Numbered citations under the answer open the exact lines.
  - **No evidence.** If the indexed files don't support an answer, RepoMind says so instead of guessing.
  - **AI budget.** When the day's shared AI budget is used up, Ask shows the most relevant passages without an AI answer until 00:00 UTC.

Links to files and lines can be opened in a new tab (Ctrl- or Cmd-click) and shared with yourself across devices. Other people can't open them, because they can't see your repositories.

**Check what matters.** Answers come from an AI model. RepoMind checks that every citation points to text it retrieved from your repository, but not that every sentence is correct, so read the cited lines before relying on an answer.

## 9. Re-index, cancel and delete

These are on the **Overview** tab, under **Manage**:
- **Re-index latest commit** (GitHub) or **Upload a new version** (ZIP). The current index stays usable until the new one is ready.
- **Cancel indexing** (GitHub) or **Cancel upload** (ZIP, shown while files upload) stops the run and removes its partial data.
- **Delete repository** asks you to type the repository's name. It removes RepoMind's stored files, search index and vectors, and frees a slot. Your GitHub repository or ZIP file is never touched.

## Troubleshooting

| What you see | What to do |
|---|---|
| "That invitation code is not valid" | Check that you copied the whole code, including `rmi_`. |
| "This invitation has already been used" | If it created your account, sign in with your sign-in key. Otherwise ask for a new invitation. |
| "This invitation has expired" or "was withdrawn" | Ask the person who sent it for a new one. |
| "That is an invitation code…" while signing in | You pasted an invitation, not your key. Your key starts with `rmk_`. |
| "This account has been disabled" | Contact the person who runs RepoMind. |
| "Too many sign-in attempts" | Wait 15 minutes. |
| Back on the sign-in screen | Your session ended. Paste your sign-in key again. |
| "Repository not found. It may be private…" | Check the URL. Private repositories can't be connected here; upload a ZIP instead. |
| "…more than 2,000 supported files" or "GitHub truncated this repository's file list" | The repository is too large. Upload a ZIP of the part you need. |
| "You can index up to 5 repositories" | Delete a repository you no longer need. |
| "You have started 20 indexing jobs today" or "today's question limit" | Wait until 00:00 UTC. |
| "RepoMind's shared indexing capacity for today is used up" | Indexing for everyone has reached today's limit. Your repositories keep working; new indexing resumes after 00:00 UTC, and paused jobs continue by themselves. |
| "You have used today's indexing allowance for your account" | Each account can index about one large repository a day. Try again after 00:00 UTC. |
| "…already indexed at the latest commit" or "same content as the version already indexed" | Nothing has changed since the last index, so there is nothing to re-index. |
| An upload stops with "Your upload is kept" | Choose the same ZIP again after 00:00 UTC to continue it (within 24 hours). |
| **Search ready · semantic index paused** | The day's shared AI budget is used up. Search, files and Ask (with keyword evidence) work now. |
| **Uploading** after you closed the tab | Choose the same ZIP again on the repository page to resume. |
| An error ending in "(reference …)" | Try again. If it persists, send the reference to the person who runs RepoMind. |

Known limitations are listed in the [README](../README.md#known-limitations).
