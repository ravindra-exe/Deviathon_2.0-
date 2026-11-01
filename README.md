
Pearl Browser 🦪

Smart Proctoring Browser |

Pearl Browser is a Chromium-based smart proctoring browser designed to provide a secure and controlled environment for online assessments. It combines modern browser functionality with assessment management and AI-assisted proctoring capabilities to support a more reliable online examination experienmt.

---

🚀 Project Overview

Online assessments face challenges related to exam integrity, unauthorized navigation, and effective assessment management.

Pearl Browser aims to address these challenges through a dedicated desktop browser environment with integrated examination functionality, administrator controls, and proctoring features.

Our goal is to build a browser that goes beyond conventional browsing and provides a structured environment for conducting online assessments.

✨ Key Features

- Chromium-Based Browser: Desktop browsing experience powered by Electron and Chromium.
- Smart Proctoring: Webcam-based monitoring and face-presence detection capabilities.
- Secure Assessment Environment: Restricted navigation and exam-session monitoring.
- Admin Dashboard: Manage assessments, questions, and examination configurations.
- Question Generation: AI-assisted MCQ question generation based on topics, difficulty, and learning objectives.
- MCQ Assessment System: Structured online examinations with configurable duration and questions.
- Automatic Exam Submission: Exam submission when specified session-exit or browser-switch conditions are detected.
- Authentication: Backend-based email OTP authentication.
- Assessment Integration: Airtable-based assessment data management.
- Browser Essentials: Tab management, bookmarks, browsing history, navigation controls, and downloads.

🛠️ Technology Stack

Category| Technologies
Desktop Framework| Electron
Browser Engine| Chromium
Frontend| React, TypeScript
Build Tool| Electron-Vite
Styling| CSS
Backend| Node.js
Database / Assessment Data| Airtable
Authentication| Email OTP, SMTP
Development Tools| VS Code, Git, GitHub

🏗️ Project Architecture

Pearl Browser follows a modular Electron architecture:

- Main Process: Handles browser windows, tabs, navigation, and application-level operations.
- Renderer Process: Provides the React-based browser interface and admin dashboard.
- Preload Layer: Uses restricted IPC communication between renderer and main processes.
- Shared Contracts: Maintains consistent types and communication interfaces.
- Backend Services: Support authentication and assessment-related operations.

🎯 Our Hackathon Journey

Participating in Deviathon 2.0 was an opportunity to turn ideas into practical implementation.

Our team secured Rank 17 after Round 2. Throughout the event, we worked on improving the project, resolving technical issues, refining the admin dashboard, and developing assessment-related functionality.

The experience strengthened our problem-solving, teamwork, and development skills.

🔮 Future Scope

- Improve AI-powered proctoring and monitoring.
- Enhance face and gaze tracking.
- Strengthen assessment security and backend validation.
- Improve real-time examination monitoring for administrators.
- Expand question generation and assessment analytics.
- Conduct extensive testing for reliability and performance.

👨‍💻 Development Team

Team: Coding Crew

Built with dedication, collaboration, and continuous learning during Deviathon 2.0.

📌 Hackathon Details

- Event: Deviathon 2.0 – National Level Hackathon
- Dates: 29–31 October 2026
- Institution: GLA University
- Achievement: Rank 17 after Round 2

---

⭐ If you find this project interesting, consider giving the repository a star!

Pearl Browser — Making Online Assessments Smarter and More Secure.
