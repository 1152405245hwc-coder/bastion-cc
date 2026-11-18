#!/usr/bin/env python3
"""Read-only, fail-closed network acceptance checks for CC Relay Forge deployments."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from typing import Iterable


CHECKS = (
    "proxy_https",
    "direct_https",
    "dns",
    "ipv4",
    "ipv6",
    "udp",
    "host_ports",
    "docker_nat",
)


@dataclass
class Result:
    name: str
    ok: bool
    detail: str


def env_required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def timeout_seconds(override: float | None) -> float:
    value = override if override is not None else float(os.environ.get("CCRF_NETWORK_TIMEOUT", "3"))
    if value <= 0:
        raise ValueError("timeout must be greater than zero")
    return value


def result(name: str, ok: bool, detail: str) -> Result:
    return Result(name=name, ok=ok, detail=detail)


def http_probe(url: str, proxy_url: str | None, timeout: float) -> Result:
    if not url.startswith(("http://", "https://")):
        return result("https", False, "URL must use http:// or https://")
    if proxy_url and not proxy_url.startswith(("http://", "https://")):
        return result("https", False, "proxy URL must use http:// or https://")

    proxies = {} if proxy_url is None else {"http": proxy_url, "https": proxy_url}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies))
    request = urllib.request.Request(url, method="GET")
    try:
        with opener.open(request, timeout=timeout) as response:
            status = int(response.status)
            response.read(1)
        if status == http.client.PROXY_AUTHENTICATION_REQUIRED:
            return result("https", False, f"proxy authentication required (HTTP {status})")
        return result("https", 200 <= status < 600, f"HTTP {status}")
    except urllib.error.HTTPError as exc:
        if exc.code == http.client.PROXY_AUTHENTICATION_REQUIRED:
            return result("https", False, f"proxy authentication required (HTTP {exc.code})")
        return result("https", 200 <= exc.code < 600, f"HTTP {exc.code}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return result("https", False, f"transport failed: {exc}")


def check_proxy_https(timeout: float) -> Result:
    try:
        target = env_required("CCRF_PROXY_TARGET_URL")
        proxy = env_required("CCRF_PROXY_URL")
    except ValueError as exc:
        return result("proxy_https", False, str(exc))
    probe = http_probe(target, proxy, timeout)
    return result("proxy_https", probe.ok, probe.detail)


def check_direct_https(timeout: float) -> Result:
    try:
        target = env_required("CCRF_DIRECT_TARGET_URL")
    except ValueError as exc:
        return result("direct_https", False, str(exc))
    probe = http_probe(target, None, timeout)
    return result("direct_https", probe.ok, probe.detail)


def check_dns(timeout: float) -> Result:
    try:
        name = env_required("CCRF_DNS_NAME")
        port = int(os.environ.get("CCRF_DNS_PORT", "443"))
        if not 1 <= port <= 65535:
            raise ValueError("CCRF_DNS_PORT must be 1..65535")
        old_timeout = socket.getdefaulttimeout()
        socket.setdefaulttimeout(timeout)
        try:
            addresses = socket.getaddrinfo(name, port, type=socket.SOCK_STREAM)
        finally:
            socket.setdefaulttimeout(old_timeout)
        unique = sorted({item[4][0] for item in addresses})
        if not unique:
            return result("dns", False, "resolver returned no addresses")
        return result("dns", True, "resolved " + ",".join(unique))
    except (ValueError, socket.gaierror, OSError) as exc:
        return result("dns", False, f"DNS failed: {exc}")


def connect_ip(name: str, family: socket.AddressFamily, timeout: float, label: str) -> Result:
    try:
        target = env_required(name)
        port_name = f"{name}_PORT"
        port = int(env_required(port_name))
        if not 1 <= port <= 65535:
            raise ValueError(f"{port_name} must be 1..65535")
        addresses = socket.getaddrinfo(target, port, family, socket.SOCK_STREAM)
        if not addresses:
            return result(label, False, "no address for requested IP family")
        errors = []
        for address in addresses:
            sock = socket.socket(address[0], address[1], address[2])
            sock.settimeout(timeout)
            try:
                sock.connect(address[4])
                return result(label, True, f"TCP connected to {address[4][0]}:{port}")
            except OSError as exc:
                errors.append(str(exc))
            finally:
                sock.close()
        return result(label, False, "all connections failed: " + " | ".join(errors))
    except (ValueError, socket.gaierror, OSError) as exc:
        return result(label, False, f"TCP check failed: {exc}")


def check_ipv4(timeout: float) -> Result:
    return connect_ip("CCRF_IPV4_TARGET", socket.AF_INET, timeout, "ipv4")


def check_ipv6(timeout: float) -> Result:
    return connect_ip("CCRF_IPV6_TARGET", socket.AF_INET6, timeout, "ipv6")


def check_udp(timeout: float) -> Result:
    try:
        target = env_required("CCRF_UDP_TARGET")
        port = int(env_required("CCRF_UDP_PORT"))
        payload = os.environ.get("CCRF_UDP_PAYLOAD", "ccrf-network-check").encode("utf-8")
        expected = env_required("CCRF_UDP_EXPECTED").encode("utf-8")
        family_name = os.environ.get("CCRF_UDP_FAMILY", "ipv4").lower()
        family = socket.AF_INET6 if family_name == "ipv6" else socket.AF_INET
        if family_name not in {"ipv4", "ipv6"}:
            raise ValueError("CCRF_UDP_FAMILY must be ipv4 or ipv6")
        addresses = socket.getaddrinfo(target, port, family, socket.SOCK_DGRAM)
        if not addresses:
            return result("udp", False, "no UDP address for requested family")
        address = addresses[0]
        sock = socket.socket(address[0], socket.SOCK_DGRAM)
        sock.settimeout(timeout)
        try:
            sock.connect(address[4])
            sock.send(payload)
            response = sock.recv(4096)
        finally:
            sock.close()
        if response != expected:
            return result("udp", False, "received response did not match CCRF_UDP_EXPECTED")
        return result("udp", True, f"received {len(response)} bytes from UDP echo target")
    except socket.timeout:
        return result("udp", False, "no UDP response before timeout; an echo service is required")
    except (ValueError, socket.gaierror, OSError) as exc:
        return result("udp", False, f"UDP check failed: {exc}")


def parse_host_port(value: str) -> tuple[str, int]:
    value = value.strip()
    if value.startswith("["):
        closing = value.find("]")
        if closing < 0 or closing + 2 > len(value) or value[closing + 1] != ":":
            raise ValueError(f"invalid host:port: {value}")
        host = value[1:closing]
        port_text = value[closing + 2 :]
    else:
        host, separator, port_text = value.rpartition(":")
        if not separator or not host:
            raise ValueError(f"invalid host:port: {value}")
    port = int(port_text)
    if not 1 <= port <= 65535:
        raise ValueError(f"port out of range: {value}")
    return host, port


def check_host_ports(timeout: float) -> Result:
    raw = os.environ.get("CCRF_HOST_PORTS", "").strip()
    if not raw:
        return result("host_ports", False, "CCRF_HOST_PORTS is required")
    failures = []
    successes = []
    for item in raw.split(","):
        try:
            host, port = parse_host_port(item)
            with socket.create_connection((host, port), timeout=timeout):
                successes.append(f"{host}:{port}")
        except (ValueError, OSError) as exc:
            failures.append(f"{item.strip()} ({exc})")
    if failures:
        return result("host_ports", False, "failed: " + " | ".join(failures))
    return result("host_ports", True, "connected: " + ", ".join(successes))


def command_output(argv: list[str], timeout: float) -> tuple[int, str, str]:
    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return completed.returncode, completed.stdout.strip(), completed.stderr.strip()


def check_docker_nat(timeout: float) -> Result:
    if not sys.platform.startswith("linux"):
        return result("docker_nat", False, "Linux-only check; iptables NAT is not a macOS host invariant")
    container = os.environ.get("CCRF_CONTAINER", "").strip()
    subnet = os.environ.get("CCRF_CONTAINER_SUBNET", "").strip()
    if not container or not subnet:
        return result("docker_nat", False, "CCRF_CONTAINER and CCRF_CONTAINER_SUBNET are required")
    docker = os.environ.get("CCRF_DOCKER_BIN") or shutil.which("docker")
    iptables = os.environ.get("CCRF_IPTABLES_BIN") or shutil.which("iptables")
    if not docker or not iptables:
        return result("docker_nat", False, "docker and iptables executables are required")
    try:
        inspect_rc, inspect_out, inspect_err = command_output(
            [docker, "inspect", "--format={{.State.Running}}", container],
            timeout,
        )
        if inspect_rc != 0:
            return result("docker_nat", False, f"docker inspect failed: {inspect_err or inspect_out}")
        if inspect_out.lower() != "true":
            return result("docker_nat", False, "container is not running")
        nat_rc, nat_out, nat_err = command_output(
            [iptables, "-t", "nat", "-S", "POSTROUTING"],
            timeout,
        )
        if nat_rc != 0:
            return result("docker_nat", False, f"iptables query failed: {nat_err or nat_out}")
        if "MASQUERADE" not in nat_out:
            return result("docker_nat", False, "POSTROUTING has no MASQUERADE rule")
        if subnet not in nat_out:
            return result("docker_nat", False, f"POSTROUTING has no MASQUERADE rule for {subnet}")
        return result("docker_nat", True, f"MASQUERADE rule found for {subnet}")
    except (OSError, subprocess.TimeoutExpired) as exc:
        return result("docker_nat", False, f"read-only command failed: {exc}")


def selected_checks(values: Iterable[str]) -> list[str]:
    selected = list(values)
    if not selected or "all" in selected:
        return list(CHECKS)
    seen = set()
    ordered = []
    for value in selected:
        if value not in CHECKS:
            raise ValueError(f"unknown check: {value}")
        if value not in seen:
            ordered.append(value)
            seen.add(value)
    return ordered


def run_checks(names: Iterable[str], timeout: float) -> list[Result]:
    functions = {
        "proxy_https": check_proxy_https,
        "direct_https": check_direct_https,
        "dns": check_dns,
        "ipv4": check_ipv4,
        "ipv6": check_ipv6,
        "udp": check_udp,
        "host_ports": check_host_ports,
        "docker_nat": check_docker_nat,
    }
    return [functions[name](timeout) for name in names]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="append",
        choices=("all", *CHECKS),
        help="check to run; repeat for several checks (default: all)",
    )
    parser.add_argument("--timeout", type=float, help="per-operation timeout in seconds")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument("--list", action="store_true", help="list check names and exit")
    args = parser.parse_args()

    if args.list:
        print("\n".join(CHECKS))
        return 0

    try:
        names = selected_checks(args.check or [])
        timeout = timeout_seconds(args.timeout)
    except ValueError as exc:
        parser.error(str(exc))

    results = run_checks(names, timeout)
    passed = all(item.ok for item in results)
    if args.json:
        print(json.dumps({"ok": passed, "results": [asdict(item) for item in results]}))
    else:
        for item in results:
            marker = "PASS" if item.ok else "FAIL"
            print(f"[{marker}] {item.name}: {item.detail}")
        print(f"summary={'PASS' if passed else 'FAIL'} checks={len(results)}")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
