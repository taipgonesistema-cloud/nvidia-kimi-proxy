@echo off
cd /d "%~dp0"
set NVIDIA_THINKING=false
set NVIDIA_MAX_TOKENS=131072
set NVIDIA_TEMPERATURE=0.2
set NVIDIA_TOP_P=0.8
node playwright-proxy.mjs
