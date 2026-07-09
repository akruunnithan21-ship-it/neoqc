@echo off
REM Runs the pcstudio.in resume scrape detached from the Claude app process tree
REM (via Task Scheduler) so closing the app doesn't kill it. Safe to re-run:
REM --resume skips already-captured URLs and continues from the last checkpoint.
cd /d "C:\Users\Aladeen\Desktop\Aladeen\neoqc-main"
"C:\Users\Aladeen\AppData\Local\Python\pythoncore-3.14-64\python.exe" -u pcstudio_import.py --resume > output\resume2_stdout.txt 2>&1
