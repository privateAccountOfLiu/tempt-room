#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <mutex>
#include <stdexcept>

// Stable N-API entrypoint ABI. No V8 headers, Node import library, or Node
// binary changes are needed; these APIs are resolved from the loading process.
struct napi_env__;
struct napi_value__;
using napi_env = napi_env__*;
using napi_value = napi_value__*;
using ThrowError = int(__cdecl*)(napi_env, const char*, const char*);
using GetBoolean = int(__cdecl*)(napi_env, bool, napi_value*);
using SetProperty = int(__cdecl*)(napi_env, napi_value, const char*, napi_value);

namespace {
using OpenPipe = HANDLE(WINAPI*)(LPCWSTR, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, LPSECURITY_ATTRIBUTES);
using OpenFile = HANDLE(WINAPI*)(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
using OpenPipeA = HANDLE(WINAPI*)(LPCSTR, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, LPSECURITY_ATTRIBUTES);
using OpenFileA = HANDLE(WINAPI*)(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
OpenPipe originalPipe;
OpenFile originalFile;
OpenPipeA originalPipeA;
OpenFileA originalFileA;
std::once_flag once;

struct PipeName {
    wchar_t local[512]{};
    LPCWSTR value;
    explicit PipeName(LPCWSTR name) : value(name) {
        if (!name) return;
        for (const auto prefix : {L"\\\\?\\pipe\\uv\\", L"\\\\.\\pipe\\uv\\"}) {
            const size_t length = wcslen(prefix);
            if (_wcsnicmp(name, prefix, length) != 0) continue;
            const auto suffix = name + length;
            if (wcslen(suffix) + 24 >= _countof(local)) return;
            // The same spelling is used by the upstream libuv AppContainer fix.
            wcscpy_s(local, L"\\\\?\\pipe\\LOCAL\\uv\\");
            wcscat_s(local, suffix);
            value = local;
            return;
        }
    }
};
struct PipeNameA {
    char local[512]{};
    LPCSTR value;
    explicit PipeNameA(LPCSTR name) : value(name) {
        if (!name) return;
        for (const auto prefix : {"\\\\?\\pipe\\uv\\", "\\\\.\\pipe\\uv\\"}) {
            const size_t length = strlen(prefix);
            if (_strnicmp(name, prefix, length) != 0) continue;
            const auto suffix = name + length;
            if (strlen(suffix) + 24 >= _countof(local)) return;
            strcpy_s(local, "\\\\?\\pipe\\LOCAL\\uv\\");
            strcat_s(local, suffix);
            value = local;
            return;
        }
    }
};

HANDLE WINAPI LocalPipe(LPCWSTR name, DWORD openMode, DWORD pipeMode, DWORD instances,
    DWORD outSize, DWORD inSize, DWORD timeout, LPSECURITY_ATTRIBUTES security) {
    PipeName mapped(name);
    return originalPipe(mapped.value, openMode, pipeMode, instances, outSize, inSize, timeout, security);
}
HANDLE WINAPI LocalFile(LPCWSTR name, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES security,
    DWORD disposition, DWORD flags, HANDLE templateFile) {
    PipeName mapped(name);
    return originalFile(mapped.value, access, share, security, disposition, flags, templateFile);
}
HANDLE WINAPI LocalPipeA(LPCSTR name, DWORD openMode, DWORD pipeMode, DWORD instances,
    DWORD outSize, DWORD inSize, DWORD timeout, LPSECURITY_ATTRIBUTES security) {
    PipeNameA mapped(name);
    return originalPipeA(mapped.value, openMode, pipeMode, instances, outSize, inSize, timeout, security);
}
HANDLE WINAPI LocalFileA(LPCSTR name, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES security,
    DWORD disposition, DWORD flags, HANDLE templateFile) {
    PipeNameA mapped(name);
    return originalFileA(mapped.value, access, share, security, disposition, flags, templateFile);
}

void RequireAppContainer() {
    HANDLE token{};
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        throw std::runtime_error("Cannot inspect process token");
    DWORD appContainer{}, needed{};
    const bool queried = GetTokenInformation(token, TokenIsAppContainer, &appContainer, sizeof(appContainer), &needed) != FALSE;
    CloseHandle(token);
    if (!queried || !appContainer)
        throw std::runtime_error("Pipe compatibility requires an actual AppContainer process");
}

void Replace(ULONG_PTR* cell, void* replacement) {
    DWORD previous{}, ignored{};
    if (!VirtualProtect(cell, sizeof(*cell), PAGE_READWRITE, &previous))
        throw std::runtime_error("Cannot update this process import table");
    InterlockedExchangePointer(reinterpret_cast<void* volatile*>(cell), replacement);
    if (!VirtualProtect(cell, sizeof(*cell), previous, &ignored))
        throw std::runtime_error("Cannot restore import-table page protection");
}

void Install() {
    RequireAppContainer();
    const auto kernel = GetModuleHandleW(L"kernel32.dll");
    originalPipe = reinterpret_cast<OpenPipe>(GetProcAddress(kernel, "CreateNamedPipeW"));
    originalFile = reinterpret_cast<OpenFile>(GetProcAddress(kernel, "CreateFileW"));
    originalPipeA = reinterpret_cast<OpenPipeA>(GetProcAddress(kernel, "CreateNamedPipeA"));
    originalFileA = reinterpret_cast<OpenFileA>(GetProcAddress(kernel, "CreateFileA"));
    if (!originalPipe || !originalFile || !originalPipeA || !originalFileA) throw std::runtime_error("Required Windows pipe APIs are missing");

    // Only this process's main executable is patched. The DLL neither opens nor
    // writes other processes, changes OS policy, or grants filesystem access.
    auto base = reinterpret_cast<unsigned char*>(GetModuleHandleW(nullptr));
    const auto dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) throw std::runtime_error("Invalid executable image");
    const auto nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC)
        throw std::runtime_error("Pipe compatibility requires a Windows x64 executable");
    const auto& directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!directory.VirtualAddress || !directory.Size) throw std::runtime_error("Executable has no import table");
    auto descriptor = reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR*>(base + directory.VirtualAddress);
    unsigned pipes{}, files{};
    for (; descriptor->Name; ++descriptor) {
        if (!descriptor->OriginalFirstThunk) continue;
        auto names = reinterpret_cast<IMAGE_THUNK_DATA64*>(base + descriptor->OriginalFirstThunk);
        auto cells = reinterpret_cast<IMAGE_THUNK_DATA64*>(base + descriptor->FirstThunk);
        for (; names->u1.AddressOfData; ++names, ++cells) {
            if (IMAGE_SNAP_BY_ORDINAL64(names->u1.Ordinal)) continue;
            const auto name = reinterpret_cast<IMAGE_IMPORT_BY_NAME*>(base + names->u1.AddressOfData)->Name;
            if (strcmp(reinterpret_cast<const char*>(name), "CreateNamedPipeW") == 0) {
                Replace(&cells->u1.Function, reinterpret_cast<void*>(LocalPipe)); ++pipes;
            } else if (strcmp(reinterpret_cast<const char*>(name), "CreateFileW") == 0) {
                Replace(&cells->u1.Function, reinterpret_cast<void*>(LocalFile)); ++files;
            } else if (strcmp(reinterpret_cast<const char*>(name), "CreateNamedPipeA") == 0) {
                Replace(&cells->u1.Function, reinterpret_cast<void*>(LocalPipeA)); ++pipes;
            } else if (strcmp(reinterpret_cast<const char*>(name), "CreateFileA") == 0) {
                Replace(&cells->u1.Function, reinterpret_cast<void*>(LocalFileA)); ++files;
            }
        }
    }
    if (!pipes || !files) throw std::runtime_error("Executable pipe imports are unsupported; no compatibility proof");
}
}

extern "C" __declspec(dllexport) int32_t node_api_module_get_api_version_v1() { return 8; }
extern "C" __declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    const auto executable = GetModuleHandleW(nullptr);
    const auto fail = reinterpret_cast<ThrowError>(GetProcAddress(executable, "napi_throw_error"));
    const auto boolean = reinterpret_cast<GetBoolean>(GetProcAddress(executable, "napi_get_boolean"));
    const auto property = reinterpret_cast<SetProperty>(GetProcAddress(executable, "napi_set_named_property"));
    if (!fail || !boolean || !property) { TerminateProcess(GetCurrentProcess(), 70); return nullptr; }
    try {
        std::call_once(once, Install);
        napi_value installed{};
        if (boolean(env, true, &installed) != 0 || property(env, exports, "installed", installed) != 0)
            throw std::runtime_error("Cannot expose pipe compatibility status");
        return exports;
    } catch (const std::exception& error) { fail(env, "ROOM_PIPE_COMPAT", error.what()); return nullptr; }
}
