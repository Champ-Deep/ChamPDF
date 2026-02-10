# Team Contributing Guide for ChamPDF

Welcome to the ChamPDF team! This guide will help you contribute effectively to our project.

## 🎯 Quick Start for Team Members

### 1. Clone and Setup

```bash
# Clone the repository
git clone https://github.com/Champ-Deep/ChamPDF.git
cd champdf

# Install frontend dependencies
npm install

# Install backend dependencies (optional - for AI features)
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

### 2. Run Development Environment

**Frontend Only (Most PDF tools):**

```bash
npm run dev
# Opens at http://localhost:5173
```

**Frontend + Backend (AI features):**

```bash
# Terminal 1: Backend
cd backend
source venv/bin/activate
uvicorn main:app --reload
# Runs at http://localhost:8000

# Terminal 2: Frontend
VITE_API_URL=http://localhost:8000 npm run dev
# Opens at http://localhost:5173
```

**Or use Docker Compose:**

```bash
docker-compose -f docker-compose.railway.yml up
# Frontend: http://localhost:5173
# Backend: http://localhost:8000
```

---

## 🌳 Git Workflow

### Branch Strategy

```
main (production)
  └── develop (staging)
       ├── feature/feature-name
       ├── fix/bug-name
       └── docs/documentation-update
```

### Branch Naming Convention

- **Features**: `feature/tool-name` or `feature/description`
  - Example: `feature/pdf-compress`, `feature/add-watermark`
- **Fixes**: `fix/issue-description`
  - Example: `fix/cors-error`, `fix/memory-leak`
- **Documentation**: `docs/topic`
  - Example: `docs/railway-deployment`, `docs/api-reference`
- **Hotfixes**: `hotfix/critical-issue`
  - Example: `hotfix/security-vulnerability`

### Workflow Steps

1. **Create a new branch:**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes and commit regularly:**

   ```bash
   git add .
   git commit -m "feat: add PDF watermark remover"
   ```

3. **Keep your branch up to date:**

   ```bash
   git fetch origin
   git rebase origin/main
   ```

4. **Push your branch:**

   ```bash
   git push origin feature/your-feature-name
   ```

5. **Create a Pull Request** on GitHub

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no code change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Build process or auxiliary tool changes
- `perf`: Performance improvements

**Examples:**

```bash
feat(backend): add AI background removal API
fix(frontend): resolve CORS error in production
docs(deployment): update Railway deployment guide
refactor(pdf-tools): optimize PDF merge performance
test(api): add unit tests for video processing
chore(deps): update dependencies to latest versions
```

---

## 🏗️ Project Structure

```
champdf/
├── backend/                    # Python FastAPI backend
│   ├── main.py                # Main FastAPI application
│   ├── image_processor.py     # AI background removal
│   ├── video_processor.py     # Video processing logic
│   ├── requirements.txt       # Python dependencies
│   ├── Dockerfile.railway     # Production Docker build
│   └── logos/                 # Logo assets for rebranding
├── src/
│   ├── js/
│   │   ├── logic/            # Tool implementations (150+ files)
│   │   ├── config/           # Configuration files
│   │   ├── components/       # Reusable components
│   │   ├── utils/            # Helper utilities
│   │   └── main.ts           # Main entry point
│   ├── pages/                # HTML pages for each tool
│   ├── css/                  # Tailwind CSS styles
│   └── partials/             # Handlebars templates
├── public/
│   ├── locales/              # i18n translation files
│   └── images/               # Static assets
├── docs/                     # VitePress documentation
├── RAILWAY_DEPLOYMENT.md     # Deployment guide
├── DEPLOYMENT_CHECKLIST.md   # Deployment steps
├── OPTIMIZATION_RECOMMENDATIONS.md
├── CHANGELOG.md              # Version history
└── vite.config.ts           # Vite configuration
```

---

## 🛠️ Development Guidelines

### Frontend (TypeScript/JavaScript)

**Adding a New PDF Tool:**

1. **Create the HTML page** in `src/pages/`:

   ```html
   <!-- src/pages/your-tool.html -->
   <!DOCTYPE html>
   <html lang="en">
     {{> navbar}}
     <main>
       <!-- Your tool UI -->
     </main>
     {{> footer}}
   </html>
   ```

2. **Create the logic file** in `src/js/logic/`:

   ```typescript
   // src/js/logic/your-tool-page.ts
   export async function processPDF(file: File) {
     // Your implementation
   }
   ```

3. **Register the tool** in `src/js/config/tools.ts`:

   ```typescript
   {
     id: "your-tool",
     name: "Your Tool Name",
     description: "Tool description",
     icon: "IconName",
     category: "organize", // or convert, edit, secure
     href: "/your-tool.html"
   }
   ```

4. **Add translations** in `public/locales/*/tools.json`:
   ```json
   {
     "your-tool": {
       "name": "Your Tool",
       "description": "Tool description"
     }
   }
   ```

### Backend (Python)

**Adding a New API Endpoint:**

1. **Add the endpoint** in `backend/main.py`:

   ```python
   @app.post("/api/your-endpoint")
   async def your_endpoint(file: UploadFile = File(...)):
       # Your implementation
       return {"result": "success"}
   ```

2. **Create processor** (if needed) in `backend/`:

   ```python
   # backend/your_processor.py
   class YourProcessor:
       async def process(self, input_path: str, output_path: str):
           # Processing logic
           return True, None
   ```

3. **Update requirements.txt** if adding new dependencies:

   ```bash
   pip install new-package
   pip freeze > requirements.txt
   ```

4. **Add tests** (future):
   ```python
   # backend/tests/test_your_endpoint.py
   def test_your_endpoint():
       # Test implementation
   ```

---

## 🧪 Testing

### Frontend Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run coverage
npm run test:coverage
```

### Backend Testing

```bash
cd backend

# Run tests with pytest
pytest

# Run with coverage
pytest --cov=. --cov-report=html

# Test specific endpoint
pytest tests/test_api.py::test_remove_background
```

### Manual Testing Checklist

Before creating a PR, test:

- [ ] Tool works in latest Chrome
- [ ] Tool works in latest Firefox
- [ ] Tool works in Safari
- [ ] Mobile responsiveness
- [ ] Error handling (invalid files, large files)
- [ ] Loading states and progress indicators
- [ ] i18n (test in another language)
- [ ] Accessibility (keyboard navigation, screen readers)

---

## 📦 Deployment

### Frontend Deployment (Cloudflare Pages)

Automatic deployment on push to `main`:

1. Push to `main` branch
2. Cloudflare Pages auto-builds
3. Deployed to https://champdf.pages.dev
4. Custom domain: https://champdf.com

**Manual Deploy:**

```bash
npm run build:production
npx wrangler pages deploy dist
```

### Backend Deployment (Railway)

Automatic deployment on push to `main`:

1. Push to `main` branch
2. Railway auto-builds using `Dockerfile.railway`
3. Deployed to https://champdf-backend-xxxxx.up.railway.app
4. Frontend auto-connects via `VITE_API_URL`

**Manual Deploy:**

```bash
railway up
```

**Check Deployment:**

```bash
# Check Railway logs
railway logs --tail

# Test health endpoint
curl https://your-backend-url/health
```

---

## 🔍 Code Review Guidelines

### For Authors

- [ ] Self-review your code first
- [ ] Test thoroughly (see testing checklist)
- [ ] Update documentation if needed
- [ ] Add/update tests
- [ ] Follow existing code style
- [ ] Keep PRs focused (one feature/fix per PR)
- [ ] Write clear PR description

### For Reviewers

- [ ] Code quality and maintainability
- [ ] Performance implications
- [ ] Security concerns
- [ ] Test coverage
- [ ] Documentation completeness
- [ ] Backward compatibility

---

## 🚀 Release Process

### Version Numbering

We use [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes (e.g., 1.0.0 → 2.0.0)
- **MINOR**: New features, backward compatible (e.g., 1.0.0 → 1.1.0)
- **PATCH**: Bug fixes, backward compatible (e.g., 1.0.0 → 1.0.1)

### Creating a Release

1. **Update version** in `package.json`:

   ```json
   {
     "version": "1.17.0"
   }
   ```

2. **Update CHANGELOG.md:**

   ```markdown
   ## [1.17.0] - 2026-01-XX

   ### Added

   - New feature description

   ### Fixed

   - Bug fix description
   ```

3. **Commit and tag:**

   ```bash
   git add .
   git commit -m "chore: release v1.17.0"
   git tag -a v1.17.0 -m "Release v1.17.0"
   git push origin main --tags
   ```

4. **Create GitHub Release:**
   - Go to GitHub → Releases → New Release
   - Select tag `v1.17.0`
   - Title: `v1.17.0`
   - Description: Copy from CHANGELOG.md
   - Attach `dist-1.17.0.zip` (if applicable)

---

## 🐛 Bug Reporting

When reporting bugs, include:

1. **Description**: What happened vs. what should happen
2. **Steps to Reproduce**:
   ```
   1. Go to '...'
   2. Click on '...'
   3. See error
   ```
3. **Environment**:
   - OS: macOS/Windows/Linux
   - Browser: Chrome 120, Firefox 121, etc.
   - Version: ChamPDF 1.16.0
4. **Screenshots/Videos**: If applicable
5. **Console Errors**: Browser console output
6. **Expected Behavior**: What should happen instead

---

## 💡 Feature Requests

When proposing features:

1. **Use Case**: Why is this needed?
2. **Proposed Solution**: How should it work?
3. **Alternatives**: Other ways to solve this
4. **Screenshots/Mockups**: Visual examples (if applicable)
5. **Priority**: Nice-to-have vs. Critical

---

## 📚 Documentation

### Updating Documentation

```bash
# Start docs dev server
npm run docs:dev

# Build docs
npm run docs:build

# Preview built docs
npm run docs:preview
```

**Documentation files:**

- `docs/index.md` - Home page
- `docs/getting-started.md` - Getting started
- `docs/tools/` - Tool reference pages
- `docs/self-hosting/` - Deployment guides

### Writing Good Documentation

- Use clear, concise language
- Include code examples
- Add screenshots for UI features
- Keep it up to date with code changes
- Use proper Markdown formatting

---

## 🤝 Communication

### Team Channels

- **Discord**: [Join our server](https://discord.gg/Bgq3Ay3f2w)
  - `#dev` - Development discussions
  - `#help` - Technical help
  - `#feature-requests` - New ideas
- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: General discussions
- **Pull Requests**: Code reviews

### Best Practices

- Be respectful and constructive
- Ask questions when unclear
- Share knowledge and help others
- Document decisions (in code comments or docs)
- Communicate blockers early

---

## 📝 Coding Standards

### TypeScript/JavaScript

- Use TypeScript for new code
- Follow existing code style (Prettier configured)
- Use meaningful variable names
- Add JSDoc comments for public functions
- Avoid `any` type, use proper typing

**Example:**

```typescript
/**
 * Merges multiple PDF files into one
 * @param files - Array of PDF files to merge
 * @param options - Merge options
 * @returns Promise resolving to merged PDF blob
 */
async function mergePDFs(files: File[], options: MergeOptions): Promise<Blob> {
  // Implementation
}
```

### Python

- Follow PEP 8 style guide
- Use type hints
- Add docstrings for functions/classes
- Use async/await for I/O operations
- Handle errors gracefully

**Example:**

```python
async def remove_background(
    input_bytes: bytes,
    output_format: str = "png"
) -> bytes:
    """
    Remove background from image using ML model.

    Args:
        input_bytes: Input image bytes
        output_format: Output format (png, jpg, webp)

    Returns:
        Processed image bytes with transparent background

    Raises:
        RuntimeError: If processing fails
    """
    # Implementation
```

---

## 🔐 Security

### Reporting Security Issues

**DO NOT** open public issues for security vulnerabilities.

Instead:

1. Email: security@champdf.com (if available)
2. Or create a private security advisory on GitHub

### Security Best Practices

- Never commit secrets (.env files, API keys)
- Validate all user inputs
- Sanitize file uploads
- Use HTTPS in production
- Keep dependencies updated
- Follow OWASP guidelines

---

## 🎉 Recognition

Contributors are recognized in:

- GitHub Contributors page
- CHANGELOG.md (for significant contributions)
- README.md (for major features)

---

## ❓ Getting Help

Stuck? Here's how to get help:

1. **Check existing docs**: README, deployment guides
2. **Search issues**: Someone may have solved this already
3. **Ask in Discord**: `#help` channel
4. **Create an issue**: Provide details (see Bug Reporting)
5. **Tag team members**: @mention for urgent issues

---

**Thank you for contributing to ChamPDF! 🚀**

Together, we're building the ultimate Swiss Army knife for PDFs.
