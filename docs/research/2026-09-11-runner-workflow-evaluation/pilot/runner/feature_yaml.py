"""Read real YAML safely; preserve Markdown/frontmatter text when changing status."""

import hashlib
import json
from pathlib import Path
import re
import subprocess

from git_state import RunError


RUBY_YAML = r'''
require 'yaml'
require 'json'
require 'date'
source = STDIN.read
def unique_keys(node)
  if node.is_a?(Psych::Nodes::Mapping)
    keys = node.children.each_slice(2).map { |key, _| key.value }
    if keys.uniq.length != keys.length
      raise 'Duplicate YAML mapping keys'
    end
  end
  if node.respond_to?(:children) && node.children
    node.children.each { |child| unique_keys(child) }
  end
end
tree = Psych.parse_stream(source)
unique_keys(tree)
puts JSON.generate(YAML.safe_load(source, permitted_classes: [Date], aliases: false))
'''


def yaml_read(source, allow_empty=False):
    try:
        result = subprocess.run(["ruby", "-e", RUBY_YAML], input=source,
                                text=True, capture_output=True, check=False)
    except FileNotFoundError as error:
        raise RunError("The filesystem adapter requires Ruby for safe YAML parsing") from error
    if result.returncode:
        raise RunError("Cannot parse ticket YAML: " + result.stderr.strip())
    value = json.loads(result.stdout)
    if value is None and allow_empty:
        return {}
    if not isinstance(value, dict):
        raise RunError("Expected a YAML mapping")
    return value


def document(path):
    raw = Path(path).read_text()
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", raw, re.S)
    if not match:
        raise RunError("Missing YAML frontmatter: " + str(path))
    metadata = yaml_read(match[1])
    return raw, metadata, match


def source_digest(path):
    raw, metadata, match = document(path)
    metadata.pop("status", None)
    stable = json.dumps(metadata, sort_keys=True) + "\n" + raw[match.end():]
    return hashlib.sha256(stable.encode()).hexdigest()


def with_status(path, status):
    raw, metadata, match = document(path)
    if "status" not in metadata:
        raise RunError("Missing ticket status: " + str(path))
    header, count = re.subn(r"(?m)^status:[^\n]*$", "status: " + status, match[1])
    if count != 1:
        raise RunError("Status must be one ordinary top-level YAML field: " + str(path))
    return raw[:match.start(1)] + header + raw[match.end(1):]
