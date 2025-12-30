#!/usr/bin/env python3
"""
Clone Vijay's voice using Fish Audio API
"""
import os
import requests
import sys

FISH_AUDIO_API_KEY = os.environ.get('FISH_AUDIO_API_KEY')
if not FISH_AUDIO_API_KEY:
    print("Error: FISH_AUDIO_API_KEY environment variable not set")
    sys.exit(1)

def create_voice_clone(name: str, audio_file: str, description: str = ""):
    """Create a voice clone using Fish Audio API"""
    url = "https://api.fish.audio/model"

    headers = {
        "Authorization": f"Bearer {FISH_AUDIO_API_KEY}"
    }

    if not os.path.exists(audio_file):
        print(f"Audio file not found: {audio_file}")
        return None

    file_size = os.path.getsize(audio_file) / (1024 * 1024)
    print(f"File size: {file_size:.2f} MB")

    # Prepare the multipart form data
    with open(audio_file, 'rb') as f:
        files = {
            'voices': (os.path.basename(audio_file), f, 'audio/webm')
        }
        data = {
            'title': name,
            'description': description or f"Voice clone of {name}",
            'visibility': 'private',
            'type': 'tts',
            'train_mode': 'fast'
        }

        print(f"Creating voice clone '{name}'...")
        print(f"Uploading to Fish Audio...")

        try:
            response = requests.post(
                url,
                headers=headers,
                data=data,
                files=files,
                timeout=300
            )

            print(f"Response status: {response.status_code}")

            if response.status_code in [200, 201]:
                result = response.json()
                print(f"Success! Voice ID: {result.get('_id', result.get('id'))}")
                print(f"Full response: {result}")
                return result
            else:
                print(f"Error: {response.status_code}")
                print(f"Response: {response.text}")
                return None
        except Exception as e:
            print(f"Exception: {e}")
            return None

def list_voices():
    """List all voices in the account"""
    url = "https://api.fish.audio/model"
    headers = {"Authorization": f"Bearer {FISH_AUDIO_API_KEY}"}

    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        result = response.json()
        voices = result.get('items', result) if isinstance(result, dict) else result
        if isinstance(voices, list):
            print(f"\nFound {len(voices)} voices:")
            for voice in voices:
                voice_id = voice.get('_id', voice.get('id', 'unknown'))
                name = voice.get('title', voice.get('name', 'unknown'))
                print(f"  - {name}: {voice_id}")
        else:
            print(f"Response: {result}")
        return voices
    else:
        print(f"Error listing voices: {response.status_code}")
        print(response.text)
    return []

if __name__ == "__main__":
    # Audio file path
    audio_file = "/Users/SankarNag/tvk-api/voice-samples/vijay_short_speech.webm"

    if not os.path.exists(audio_file):
        print(f"Audio file not found: {audio_file}")
        sys.exit(1)

    # First, list existing voices
    print("Checking existing voices...")
    list_voices()

    # Create the voice clone
    print("\n" + "="*50)
    result = create_voice_clone(
        name="Vijay TVK",
        audio_file=audio_file,
        description="Thalapathy Vijay's voice for TVK AI assistant - cloned from Tamil speech"
    )

    if result:
        voice_id = result.get('_id', result.get('id'))
        print(f"\n{'='*50}")
        print(f"Voice clone created successfully!")
        print(f"Voice ID: {voice_id}")
        print(f"\nAdd this to your Vercel environment:")
        print(f"VIJAY_VOICE_ID={voice_id}")
