---
title: "Creating a Personal Website with Hugo"
aliases: ["/til/hugo-site-generation/"]
date: 2025-02-14
author: "Sabit Shaikholla"
description: "A comprehensive guide on creating a personal website using Hugo static site generator with PaperMod theme, including installation, configuration, and deployment to GitHub Pages"
summary: "A comprehensive guide on creating a personal website using Hugo static site generator with PaperMod theme, including installation, configuration, and deployment to GitHub Pages"
tags: ["Hugo", "Web", "GitHub Pages", "Static Site"]
categories: ["Web Development"]
series: ["Hugo Learning"]
showtoc: true
tocopen: false
---

## Introduction

Today I'll share my experience setting up a personal website using Hugo with the PaperMod theme. This guide covers everything from installation to deployment on GitHub Pages.

## Prerequisites

Before starting, ensure you have:
- Git installed
- GitHub account
- Basic command line knowledge
- Text editor

## Installation Steps

### 1. Install Hugo

**On macOS:**

```bash
brew install hugo
```

**On Linux:**

```bash
sudo apt install hugo
```

Verify installation:

```bash
hugo version
```

### 2. Create a New Hugo Site

Create new Hugo site
```bash
hugo new site my-website
cd my-website
```

Initialize a Git repository
```bash
git init
```

### 3. Install PaperMod Theme

Add PaperMod theme as a git submodule

```bash
git submodule add https://github.com/adityatelange/hugo-PaperMod.git themes/PaperMod
```

## Project Structure

Here's the complete structure of a Hugo website:

```bash
my-portfolio/
├── archetypes/
│ └── post.md # Template for new posts
├── assets/
│ └── css/
│    └── extended/
│       └── custom.css # Custom styles
├── content/
│ ├── index.md # Homepage content
│ ├── search.md # Search page
│ ├── til/ # Today I Learned posts
│ │ ├── _index.md
│ │ └── .md
│ ├── portfolio/ # Portfolio items
│ │ └── _index.md
│ └── random/ # Random posts
│   └── _index.md
├── static/
│ └── images/ # Image files
├── themes/
│ └── PaperMod/ # PaperMod theme
├── .github/
│ └── workflows/
│   └── hugo.yml # GitHub Actions workflow
├── .gitignore
├── .gitmodules
└── config.yml # Site configuration
```

## Configuration

### 1. Basic Configuration

Create `config.yml` with essential settings:

```yaml
baseURL: "https://username.github.io/"
title: "Your Name"
theme: [PaperMod]
...
```
See details in PaperMod theme [wiki](https://github.com/adityatelange/hugo-PaperMod/wiki)

### 2. Content Structure

Create necessary directories and index files:

```bash
mkdir -p content/{til,portfolio,random}
touch content/{index,search,til/_index.md}
```

### 3. Create First Post

Create a new post:

```bash
hugo new til/first-til.md
```

## Local Development

1. Start the development server:

```bash
hugo server -D
```

2. Open your browser and navigate to `http://localhost:1313` to view your site

## Deployment to GitHub Pages

1. Create GitHub repository: `username.github.io`

2. Configure GitHub Actions:
   - Create `.github/workflows/hugo.yml`
   - Add deployment workflow configuration

3. Push to GitHub:

```bash
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/username/username.github.io.git
git push -u origin main
```

## Key Features Implemented

1. **Dark Theme**
   - Default dark theme with toggle option
   - Custom CSS for better readability

2. **Search Functionality**
   - Full-text search across posts
   - Tag-based filtering

3. **Content Organization**
   - TIL (Today I Learned) section
   - Portfolio showcase
   - Random thoughts/blog posts

4. **Navigation**
   - Table of Contents for posts
   - Breadcrumbs
   - Post navigation

## Customization Tips

1. **Theme Customization**
   - Add custom CSS in `assets/css/extended/custom.css`
   - Modify existing theme parameters in `config.yml`

2. **Content Management**
   - Use front matter for metadata
   - Organize content with tags and categories
   - Add images to `static/images/`

## Conclusion

Hugo with PaperMod theme provides an excellent foundation for a personal website. The combination of speed, flexibility, and ease of use makes it a great choice for developers looking to create and maintain a professional online presence.

## Resources

- [Hugo Documentation](https://gohugo.io/documentation/)
- [PaperMod Wiki](https://github.com/adityatelange/hugo-PaperMod/wiki)
- [GitHub Pages Documentation](https://docs.github.com/en/pages)
- [Markdown Guide](https://www.markdownguide.org/)