#!/usr/bin/env bash
# Sobe o servidor de transcrição com as libs CUDA (cuBLAS/cuDNN) instaladas via pip no venv.
cd "$(dirname "$0")"
NV=$(.venv/bin/python -c 'import os, nvidia; print(os.path.dirname(nvidia.__path__[0]))')/nvidia
export LD_LIBRARY_PATH="$NV/cublas/lib:$NV/cudnn/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec .venv/bin/python -u server.py
