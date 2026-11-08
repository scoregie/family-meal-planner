# Restoring from an offsite backup

`tools/offsite-backup.sh` uploads an encrypted copy of the whole app folder (code, `.env`,
`plan.json` and `data/`) to a private GitHub repository as a release. To get the app back on a
new machine or container:

1. **Install the tools** (Debian or Ubuntu):

       apt update && apt install -y docker.io docker-compose-v2 age gh
       gh auth login

2. **Put the backup key in place.** This is the `key.txt` you saved when backups were set up
   (it starts with `AGE-SECRET-KEY-`). Without it the backups can't be opened.

       mkdir -p ~/.config/family-planner-backup && chmod 700 ~/.config/family-planner-backup
       nano ~/.config/family-planner-backup/key.txt      # paste the key, save
       chmod 600 ~/.config/family-planner-backup/key.txt

3. **Download the newest backup and unpack it** (replace the repository name with yours):

       cd /home
       gh release download --repo you/your-private-backup-repo --pattern '*.age'
       age -d -i ~/.config/family-planner-backup/key.txt family-planner-*.tar.gz.age | tar -xz

   If there are several files, use the newest one (the date is in the name). This makes the
   app folder (for example `/home/shopping-list-selfhost`) exactly as it was.

4. **Start it:**

       cd /home/shopping-list-selfhost
       docker compose up -d

   The first start downloads the Docker images and the assistant's package, so it needs the
   internet. Logins, the plan, ticks, history, progress and uploads are all back.

5. **Turn backups back on** on the new machine: copy `recipient.txt` and `config` into
   `~/.config/family-planner-backup/` (or make them again as described at the top of
   `tools/offsite-backup.sh`), then add the cron line from the README.
