#pragma once
#include <windows.h>
#include <array>
#include <algorithm>
#include <cwctype>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace wire {
constexpr uint16_t Version = 1;
constexpr uint32_t LaunchLimit = 1024 * 1024, ControlLimit = 4096;
enum Op : uint16_t { Launch=1, Resume=2, Stop=3, Release=4,
  Prepared=101, Resumed=102, Stopped=103, Released=104, Failed=105, RootExit=106 };
struct Frame { uint16_t op; uint64_t id; std::array<uint8_t,16> generation;
  std::vector<uint8_t> payload; };
template<class T> T get(const uint8_t* p) { T v; std::memcpy(&v,p,sizeof(v)); return v; }
template<class T> void append(std::vector<uint8_t>& out,T v) {
  auto p=reinterpret_cast<const uint8_t*>(&v); out.insert(out.end(),p,p+sizeof(v));
}
inline bool readExact(HANDLE pipe,void* data,DWORD size) {
  auto p=static_cast<uint8_t*>(data);
  while(size) { DWORD n=0; if(!ReadFile(pipe,p,size,&n,nullptr)||!n) return false;
    p+=n; size-=n; } return true;
}
inline bool read(HANDLE pipe,Frame& frame) {
  std::array<uint8_t,32> header{};
  if(!readExact(pipe,header.data(),32)) return false;
  uint32_t size=get<uint32_t>(header.data());
  frame.op=get<uint16_t>(header.data()+6);
  if(get<uint16_t>(header.data()+4)!=Version||frame.op<Launch||frame.op>Release||
    size>(frame.op==Launch?LaunchLimit:ControlLimit)) throw std::runtime_error("header");
  frame.id=get<uint64_t>(header.data()+8);
  std::copy(header.begin()+16,header.end(),frame.generation.begin());
  frame.payload.resize(size);
  if(size&&!readExact(pipe,frame.payload.data(),size)) throw std::runtime_error("truncated");
  return true;
}
inline std::vector<uint8_t> encode(const Frame& frame) {
  std::vector<uint8_t> out;
  append(out,static_cast<uint32_t>(frame.payload.size())); append(out,Version);
  append(out,frame.op); append(out,frame.id);
  out.insert(out.end(),frame.generation.begin(),frame.generation.end());
  out.insert(out.end(),frame.payload.begin(),frame.payload.end()); return out;
}
struct LaunchSpec { std::wstring executable,command,cwd; std::vector<wchar_t> env; };
class Cursor {
  const std::vector<uint8_t>& bytes; size_t position=0;
public:
  explicit Cursor(const std::vector<uint8_t>& data):bytes(data){}
  uint32_t integer() { if(position+4>bytes.size()) throw std::runtime_error("length");
    auto v=get<uint32_t>(bytes.data()+position); position+=4; return v; }
  std::wstring text() {
    auto size=integer();
    if(size%2||size>65534||position+size>bytes.size()) throw std::runtime_error("string");
    std::wstring s(size/2,L'\0'); std::memcpy(s.data(),bytes.data()+position,size); position+=size;
    for(size_t i=0;i<s.size();++i) {
      auto c=static_cast<uint16_t>(s[i]); if(!c) throw std::runtime_error("nul");
      if(c>=0xd800&&c<=0xdbff) { if(++i>=s.size()||s[i]<0xdc00||s[i]>0xdfff)
        throw std::runtime_error("surrogate"); }
      else if(c>=0xdc00&&c<=0xdfff) throw std::runtime_error("surrogate");
    } return s;
  }
  void end() { if(position!=bytes.size()) throw std::runtime_error("trailing"); }
};
inline bool absolute(const std::wstring& s) {
  return (s.size()>2&&iswalpha(s[0])&&s[1]==L':'&&s[2]==L'\\')||
    (s.size()>2&&s[0]==L'\\'&&s[1]==L'\\');
}
inline LaunchSpec launch(const std::vector<uint8_t>& payload) {
  Cursor cursor(payload); LaunchSpec s;
  s.executable=cursor.text(); s.command=cursor.text(); s.cwd=cursor.text();
  if(!absolute(s.executable)||!absolute(s.cwd)||s.command.empty()) throw std::runtime_error("path");
  auto count=cursor.integer(); if(count>4096) throw std::runtime_error("environment");
  std::vector<std::wstring> entries;
  for(uint32_t i=0;i<count;++i) {
    auto entry=cursor.text(); auto split=entry.find(L'=');
    if(split==std::wstring::npos||!split) throw std::runtime_error("environment");
    entries.push_back(std::move(entry));
  }
  auto name=[](const std::wstring& e) { return e.substr(0,e.find(L'=')); };
  std::sort(entries.begin(),entries.end(),[&](const auto& a,const auto& b) {
    return CompareStringOrdinal(name(a).c_str(),-1,name(b).c_str(),-1,TRUE)==CSTR_LESS_THAN;
  });
  for(size_t i=0;i<entries.size();++i) {
    if(i&&CompareStringOrdinal(name(entries[i-1]).c_str(),-1,name(entries[i]).c_str(),-1,TRUE)==CSTR_EQUAL)
      throw std::runtime_error("duplicate environment");
    s.env.insert(s.env.end(),entries[i].begin(),entries[i].end()); s.env.push_back(0);
  }
  s.env.push_back(0); if(!count) s.env.push_back(0); cursor.end(); return s;
}
} // namespace wire
