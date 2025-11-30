# CI/CD Setup for No-Mistake Autotrader v1 (Core Modules)

This project includes a ready-to-use **GitHub Actions** workflow that provides:

1. Basic **CI**:
   - Backend dependency install
   - Syntax compilation for the FastAPI app (catches code errors)
2. Basic **Docker build check**:
   - Builds backend Docker image
   - Builds a simple frontend image

You can later extend this to:
- Push images to Docker Hub or GHCR
- Deploy automatically to a VPS / server via SSH

---

## 1. Files Added

- `.github/workflows/ci-cd.yml` – main CI/CD workflow
- `CI_CD_SETUP.md` – this guide

Commit these files to your **GitHub repository** to enable CI/CD.

---

## 2. How the Workflow Works

### Triggers

The workflow runs on:

- `push` to `main` or `master`
- `pull_request` to `main` or `master`
- Manual run via **"Run workflow"** button (workflow_dispatch)

### Jobs

#### 2.1 `backend-tests`

- Runs on `ubuntu-latest`
- Steps:
  1. Checkout repo
  2. Setup Python 3.11
  3. Install backend requirements: `backend/requirements.txt`
  4. Run `python -m compileall app` inside `backend/`
     - This compiles all `.py` files and fails if syntax is invalid

> This ensures you don't break the backend with bad code.

#### 2.2 `docker-build`

- Depends on `backend-tests` (only runs if tests pass)
- Steps:
  1. Checkout repo
  2. Setup Docker Buildx
  3. Build backend Docker image from `backend/Dockerfile`
  4. Build a simple frontend Docker image using `nginx` + `frontend` folder

> This ensures your Docker images keep building successfully.

---

## 3. How to Enable CI/CD in GitHub

1. Create a new GitHub repository (or use an existing one).
2. Push the contents of `no_mistake_v1_core` to GitHub:

   ```bash
   cd no_mistake_v1_core
   git init
   git remote add origin git@github.com:YOUR_USER/no-mistake-v1-core.git
   git add .
   git commit -m "Initial commit – v1 core with CI/CD"
   git push -u origin main
   ```

3. In GitHub:
   - Go to **Actions** tab.
   - You should see `No-Mistake v1 – CI/CD` workflow.
   - On next push/open PR, it will run automatically.

---

## 4. Optional: Add Docker Registry Push (Later)

When you are ready to push images to a container registry:

1. Create secrets in GitHub:
   - `DOCKERHUB_USERNAME`
   - `DOCKERHUB_TOKEN` (or `DOCKERHUB_PASSWORD`)

2. Extend `docker-build` job in `.github/workflows/ci-cd.yml` like:

   ```yaml
   - name: Login to Docker Hub
     uses: docker/login-action@v3
     with:
       username: ${{ secrets.DOCKERHUB_USERNAME }}
       password: ${{ secrets.DOCKERHUB_TOKEN }}

   - name: Build & Push backend image
     uses: docker/build-push-action@v6
     with:
       context: ./backend
       push: true
       tags: yourdockeruser/no-mistake-backend:latest
   ```

3. On push to `main`, images will be built & pushed to Docker Hub.

---

## 5. Optional: Auto-Deploy to Your Server

You can add a **third job** `deploy` that:

- Runs after `docker-build`
- SSH into your server
- Pulls latest images
- Runs `docker compose up -d`

High-level example (you or I can help tune this later):

```yaml
deploy:
  needs: docker-build
  runs-on: ubuntu-latest
  if: github.ref == 'refs/heads/main'
  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Deploy via SSH
      uses: appleboy/ssh-action@v1.0.3
      with:
        host: ${{ secrets.SSH_HOST }}
        username: ${{ secrets.SSH_USER }}
        key: ${{ secrets.SSH_KEY }}
        script: |
          cd /path/to/no_mistake_v1_core
          git pull
          docker compose pull
          docker compose up -d --build
```

You would need to set:

- `SSH_HOST`, `SSH_USER`, `SSH_KEY` secrets in GitHub.

---

## 6. Summary

- CI/CD is now **wired via GitHub Actions**.
- Every push:
  - Confirms backend Python code compiles.
  - Confirms backend and frontend Docker builds succeed.
- You can extend:
  - Push images
  - Remote deploy
  - Add tests as the system grows.

This gives you a **professional baseline CI/CD pipeline** from v1.
