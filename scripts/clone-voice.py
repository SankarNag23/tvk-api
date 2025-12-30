#!/usr/bin/env python3
"""
Clone Vijay's voice using ElevenLabs API
"""
import os
import requests
import sys

ELEVENLABS_API_KEY = os.environ.get('ELEVENLABS_API_KEY')
if not ELEVENLABS_API_KEY:
    print("Error: ELEVENLABS_API_KEY environment variable not set")
    sys.exit(1)

def create_voice_clone(name: str, audio_files: list, description: str = ""):
    """Create a voice clone using ElevenLabs API"""
    url = "https://api.elevenlabs.io/v1/voices/add"

    headers = {
        "xi-api-key": ELEVENLABS_API_KEY
    }

    # Prepare files for upload
    files = []
    for i, audio_path in enumerate(audio_files):
        if os.path.exists(audio_path):
            files.append(('files', (f'sample_{i}.webm', open(audio_path, 'rb'), 'audio/webm')))

    if not files:
        print("No valid audio files found!")
        return None

    data = {
        'name': name,
        'description': description or f"Voice clone of {name}",
    }

    print(f"Creating voice clone '{name}' with {len(files)} audio file(s)...")

    response = requests.post(url, headers=headers, data=data, files=files)

    # Close file handles
    for _, (_, f, _) in files:
        f.close()

    if response.status_code == 200:
        result = response.json()
        print(f"Success! Voice ID: {result.get('voice_id')}")
        return result
    else:
        print(f"Error: {response.status_code}")
        print(response.text)
        return None

def list_voices():
    """List all voices in the account"""
    url = "https://api.elevenlabs.io/v1/voices"
    headers = {"xi-api-key": ELEVENLABS_API_KEY}

    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        voices = response.json().get('voices', [])
        print(f"\nFound {len(voices)} voices:")
        for voice in voices:
            print(f"  - {voice['name']}: {voice['voice_id']}")
        return voices
    return []

def delete_voice(voice_id: str):
    """Delete a voice"""
    url = f"https://api.elevenlabs.io/v1/voices/{voice_id}"
    headers = {"xi-api-key": ELEVENLABS_API_KEY}
    response = requests.delete(url, headers=headers)
    return response.status_code == 200

if __name__ == "__main__":
    # First, list existing voices
    print("Checking existing voices...")
    list_voices()

    # Audio file path
    audio_file = "/Users/SankarNag/tvk-api/voice-samples/vijay_speech_l_nUecO8oKE.webm"

    if not os.path.exists(audio_file):
        print(f"Audio file not found: {audio_file}")
        sys.exit(1)

    # Check file size (ElevenLabs has limits)
    size_mb = os.path.getsize(audio_file) / (1024 * 1024)
    print(f"\nAudio file size: {size_mb:.2f} MB")

    if size_mb > 10:
        print("Warning: File is large. ElevenLabs may reject it.")
        print("Consider using ffmpeg to extract a shorter segment.")

    # Create the voice clone
    result = create_voice_clone(
        name="Vijay TVK",
        audio_files=[audio_file],
        description="Thalapathy Vijay's voice for TVK AI assistant - cloned from Vikravandi rally speech"
    )

    if result:
        print(f"\n✅ Voice clone created successfully!")
        print(f"Voice ID: {result.get('voice_id')}")
        print(f"\nAdd this to your Vercel environment:")
        print(f"VIJAY_VOICE_ID={result.get('voice_id')}")
