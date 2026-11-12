# HOSO-CHAT PROJECT DIRECTORY STRUCTURE

- **`chat/`**: Active production frontend web files (`index.html`, `hr-admin.html`, `login-*.html`, `hr.css`). Mounted into Nginx container `hr-gateway` (`/usr/share/nginx/chat`).
- **`chat/templates/`**: Canonical CSV and document templates for user, employee, and document imports.
- **`files/`**: Storage volume for document attachments, mounted into Nginx WebDAV (`/chat/files/`).
- **`nginx/`**: Nginx configuration files (`default.conf`, `.htpasswd`).
- **`tai-khoan-he-thong/`**: Regression and authorization test suites (`test_backend_security.py`, `test_chatbot_security.py`, `test_document_rbac.py`, etc.).
- **`workflows_modified.json`**: Primary canonical export of active n8n workflows.
