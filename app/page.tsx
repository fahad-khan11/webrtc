'use client'
import Image from "next/image";
import { useSocket } from "./provider/socket";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const socket = useSocket();
  const [email, setEmail] = useState('');
  const [roomCode, setRoomCode] = useState('');

  const router = useRouter();

  const handleRoomJoin = useCallback(({ roomId }: { roomId: string }) => {
    router.push(`/room/${roomId}`);
  },[router])

  useEffect(() => {
    // Only add the listener if socket exists
    if (socket) {
      socket.on('room-joined', handleRoomJoin);
    }
    return () => {
      if (socket) {
        socket.off('room-joined', handleRoomJoin);
      }
    }
  }, [handleRoomJoin,socket]); // Include handleRoomJoin in dependencies if it changes

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (socket) {
      socket.emit('join-room', { roomId: roomCode, emailId: email });
      // Handle navigation or UI change after joining
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-600 via-blue-500 to-teal-400">
      <div className="bg-white bg-opacity-10 p-8 rounded-xl shadow-2xl backdrop-blur-md w-full max-w-md mx-4">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-black mb-2">Video Chat</h1>
          <p className="text-black">Connect with others through video chat</p>
        </div>

        <form className="space-y-6" onSubmit={handleJoinRoom}>
          <div>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-3 rounded-lg bg-white bg-opacity-20 border border-gray-300 border-opacity-20 focus:outline-none focus:ring-2 focus:ring-white focus:border-transparent text-gray-600 placeholder-gray-600"
              placeholder="yourname@example.com"
              required
            />
          </div>

          <div>
            <input
              type="text"
              id="roomCode"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value)}
              className="w-full px-4 py-3 rounded-lg bg-white bg-opacity-20 border border-gray-300 border-opacity-20 focus:outline-none focus:ring-2 focus:ring-white focus:border-transparent text-gray-600 placeholder-gray-600"
              placeholder="Room code"
              required
            />
          </div>

          <button
            type="submit"
            className="w-full bg-gradient-to-r from-blue-500 to-teal-400 hover:from-blue-600 hover:to-teal-500 text-gray-600 font-bold py-3 px-4 rounded-lg transition duration-300 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 shadow-lg"
          >
            Enter Room
          </button>
        </form>
      </div>
    </div>
  );
}
