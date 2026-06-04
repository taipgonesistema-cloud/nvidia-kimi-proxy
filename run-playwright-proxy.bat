@echo off
cd /d "%~dp0"
set NVIDIA_THINKING=false
set NVIDIA_MAX_TOKENS=131072
node playwright-proxy.mjs
